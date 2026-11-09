package expo.modules.t3homewidgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.widget.RemoteViews
import expo.modules.t3appicon.AppIconStyle
import expo.modules.t3localserver.LocalServerOptions
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean

/** Which stored data a widget draws: the app publishes "threads" and "usage"; the rest is native. */
enum class WidgetKind(val id: String, val provider: Class<out AppWidgetProvider>, val dataKey: String?) {
  WORKING("working", WorkingThreadsWidget::class.java, "threads"),
  RECENT("recent", RecentThreadsWidget::class.java, "threads"),
  SERVER("server", ServerWidget::class.java, null),
  ACTIONS("actions", QuickActionsWidget::class.java, null),
  USAGE("usage", UsageTodayWidget::class.java, "usage"),
  PROMPT("prompt", NewThreadBarWidget::class.java, null),
  GAUGES("gauges", GaugesWidget::class.java, "threads"),
  STATUS("status", StatusLineWidget::class.java, "threads"),
  ;

  companion object {
    /** Widgets that show the built-in server's state or memory. */
    val SERVER_STATE = arrayOf(SERVER, GAUGES, STATUS)
    /** Widgets that link the newest web server. */
    val WEB_SERVER = arrayOf(SERVER, ACTIONS, PROMPT)
  }
}

class WidgetSize(val widthDp: Int, val heightDp: Int) {
  companion object {
    fun of(context: Context, options: Bundle?): WidgetSize {
      if (options == null) return WidgetSize(0, 0)
      val portrait = context.resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
      return if (portrait) {
        WidgetSize(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH), options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT))
      } else {
        WidgetSize(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH), options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT))
      }
    }
  }
}

/** Data the app published, and whether the process that published it is this one. */
class StoredData(val json: JSONObject, val alive: Boolean, val confirmedAt: Long) {
  val live get() = json.optBoolean("live", false)
  val asOf get() = json.optLong("asOf", confirmedAt)
  val stale get() = WidgetFreshness.isStale(alive, live)

  /** The "Updated … ago" stamp, or null while the data is current. */
  fun stamp(now: Long = System.currentTimeMillis()): String? =
    if (!stale) null else WidgetFreshness.label(now - WidgetFreshness.since(live, asOf, confirmedAt))
}

object HomeWidgets {
  private const val TAG = "T3HomeWidgets"
  private const val PREFS = "t3_home_widgets"
  private const val COALESCE_MILLIS = 400L
  private const val MIN_INTERVAL_MILLIS = 3_000L

  /** Differs for every process, so data from a process that has died is recognised as such. */
  private val processToken = "${Process.myPid()}:${System.currentTimeMillis()}"

  private val handler by lazy { Handler(HandlerThread("t3-home-widgets").apply { start() }.looper) }
  private val pending = ConcurrentHashMap.newKeySet<WidgetKind>()
  private val scheduled = AtomicBoolean(false)
  @Volatile private var lastFlush = 0L
  /** What each widget shows now; a render with the same model is not sent to the launcher. */
  private val shown = ConcurrentHashMap<Int, Any>()
  private val placedListeners = CopyOnWriteArraySet<() -> Unit>()
  @Volatile private var placedCache: Set<WidgetKind>? = null

  fun post(block: () -> Unit) = handler.post { runCatching(block).onFailure { Log.w(TAG, "Widget update failed", it) } }

  fun postDelayed(delayMillis: Long, block: () -> Unit) =
    handler.postDelayed({ runCatching(block).onFailure { Log.w(TAG, "Widget update failed", it) } }, delayMillis)

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ---- placement -------------------------------------------------------------------------

  fun ids(context: Context, kind: WidgetKind): IntArray =
    runCatching { AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, kind.provider)) }
      .getOrDefault(IntArray(0))

  fun placed(context: Context): Set<WidgetKind> =
    placedCache ?: WidgetKind.entries.filter { ids(context, it).isNotEmpty() }.toSet().also { placedCache = it }

  fun addPlacedListener(listener: () -> Unit) = placedListeners.add(listener)

  fun removePlacedListener(listener: () -> Unit) = placedListeners.remove(listener)

  internal fun placementChanged(context: Context) {
    val before = placedCache
    placedCache = null
    if (before != placed(context)) placedListeners.forEach { it() }
    scheduleCheck(context)
  }

  internal fun forget(ids: IntArray) = ids.forEach { shown.remove(it) }

  // ---- data from the app -----------------------------------------------------------------

  fun configure(context: Context, scheme: String) {
    if (prefs(context).getString("scheme", null) != scheme) prefs(context).edit().putString("scheme", scheme).apply()
  }

  fun scheme(context: Context): String? =
    prefs(context).getString("scheme", null) ?: runCatching { LocalServerOptions(context).appScheme }.getOrNull()

  fun publish(context: Context, key: String, json: String) {
    val parsed = runCatching { JSONObject(json) }.getOrElse { return }
    if (parsed.optInt("v") != 1) return
    prefs(context).edit()
      .putString("data:$key", json)
      .putString("token:$key", processToken)
      .putLong("confirmed:$key", System.currentTimeMillis())
      .apply()
    refresh(context, *WidgetKind.entries.filter { it.dataKey == key }.toTypedArray())
    post { scheduleCheck(context) }
  }

  fun readRaw(context: Context, key: String): String? = prefs(context).getString("data:$key", null)

  fun read(context: Context, key: String): StoredData? {
    val prefs = prefs(context)
    val json = prefs.getString("data:$key", null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
    return StoredData(json, prefs.getString("token:$key", null) == processToken, prefs.getLong("confirmed:$key", 0L))
  }

  // ---- rendering -------------------------------------------------------------------------

  /**
   * Coalesces bursts (install progress, several shell pushes) into one pass, and redraws at
   * most every [MIN_INTERVAL_MILLIS] however often the app publishes.
   */
  fun refresh(context: Context, vararg kinds: WidgetKind) {
    val app = context.applicationContext
    pending.addAll(kinds)
    if (!scheduled.compareAndSet(false, true)) return
    val delay = maxOf(COALESCE_MILLIS, lastFlush + MIN_INTERVAL_MILLIS - SystemClock.elapsedRealtime())
    handler.postDelayed({
      scheduled.set(false)
      lastFlush = SystemClock.elapsedRealtime()
      val due = WidgetKind.entries.filter { pending.remove(it) }
      for (kind in due) runCatching { render(app, kind, ids(app, kind), force = false) }
        .onFailure { Log.w(TAG, "Could not draw the ${kind.id} widget", it) }
    }, delay)
  }

  fun refreshAll(context: Context) = refresh(context, *WidgetKind.entries.toTypedArray())

  fun render(context: Context, kind: WidgetKind, ids: IntArray, force: Boolean) {
    if (ids.isEmpty()) return
    val manager = AppWidgetManager.getInstance(context)
    for (id in ids) {
      val size = WidgetSize.of(context, manager.getAppWidgetOptions(id))
      val model: WidgetModel = when (kind) {
        WidgetKind.WORKING, WidgetKind.RECENT -> ThreadsWidgetModel.from(context, kind, size)
        WidgetKind.SERVER -> ServerWidgetModel.from(context, size)
        WidgetKind.ACTIONS -> ActionsWidgetModel.from(context, size)
        WidgetKind.USAGE -> UsageWidgetModel.from(context, size)
        WidgetKind.PROMPT -> PromptWidgetModel.from(context)
        WidgetKind.GAUGES -> GaugesWidgetModel.from(context)
        WidgetKind.STATUS -> StatusWidgetModel.from(context)
      }
      if (!force && shown[id] == model) continue
      manager.updateAppWidget(id, model.views(context))
      shown[id] = model
    }
    if (kind in WidgetKind.SERVER_STATE) ServerWidgetWatcher.afterRender(context)
  }

  // ---- freshness checks ------------------------------------------------------------------

  private fun checkIntent(context: Context) = PendingIntent.getBroadcast(
    context,
    0,
    Intent(context, WidgetCheckReceiver::class.java).setAction(WidgetCheckReceiver.ACTION),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  /**
   * One inexact, non-waking alarm for all data widgets: it re-confirms fresh data, or redraws
   * the stamp when its text changes. None is set when no data widget is on a home screen.
   */
  fun scheduleCheck(context: Context) {
    val now = System.currentTimeMillis()
    val placed = placed(context)
    val next = placed.mapNotNull { it.dataKey }.distinct().mapNotNull { key ->
      val data = read(context, key) ?: return@mapNotNull null
      WidgetFreshness.nextCheck(now, data.alive, data.live, data.asOf, data.confirmedAt)
    }.minOrNull()
    val alarms = context.getSystemService(AlarmManager::class.java) ?: return
    val operation = checkIntent(context)
    if (next == null) alarms.cancel(operation) else alarms.set(AlarmManager.RTC, next, operation)
  }

  internal fun check(context: Context) {
    val placed = placed(context)
    val edit = prefs(context).edit()
    for (key in placed.mapNotNull { it.dataKey }.distinct()) {
      val data = read(context, key) ?: continue
      if (!data.stale) edit.putLong("confirmed:$key", System.currentTimeMillis())
    }
    edit.apply()
    for (kind in placed) render(context, kind, ids(context, kind), force = false)
    scheduleCheck(context)
  }

  // ---- taps ------------------------------------------------------------------------------

  /** The app at an in-app path, on MainActivity itself so every icon preset's alias works. */
  fun openApp(context: Context, path: String): PendingIntent {
    val packageManager = context.packageManager
    val intent = packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
    intent.resolveActivityInfo(packageManager, 0)?.let { intent.setClassName(context.packageName, it.targetActivity ?: it.name) }
    val scheme = scheme(context)
    if (scheme != null && path != "/") intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse("$scheme:/$path"))
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, path.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun openUrl(context: Context, url: String): PendingIntent = PendingIntent.getActivity(
    context,
    url.hashCode(),
    Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )
}

/** A widget's content; equal models draw the same views, so redundant updates are skipped. */
interface WidgetModel {
  fun views(context: Context): RemoteViews
}

/** The chosen launcher icon preset, for widgets that show the app icon. */
object WidgetIcon {
  private val cache = ConcurrentHashMap<String, Int>()

  fun presetId(context: Context): String = AppIconStyle.presetId(context)

  fun resource(context: Context): Int {
    val id = presetId(context)
    return cache.getOrPut(id) {
      val res = context.resources
      res.getIdentifier("t3_icon_${id}_round", "mipmap", context.packageName).takeIf { it != 0 }
        ?: res.getIdentifier("ic_launcher_round", "mipmap", context.packageName).takeIf { it != 0 }
        ?: context.applicationInfo.icon
    }
  }
}

/** Fires the freshness check alarm. Not exported: only this app's own alarm sends it. */
class WidgetCheckReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    val result = goAsync()
    HomeWidgets.post {
      try {
        HomeWidgets.check(context.applicationContext)
      } finally {
        result.finish()
      }
    }
  }

  companion object {
    const val ACTION = "expo.modules.t3homewidgets.CHECK"
  }
}
