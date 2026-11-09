package expo.modules.t3homewidgets

import android.app.ActivityManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.os.PowerManager
import android.view.View
import android.widget.RemoteViews
import expo.modules.t3localserver.DevServers
import expo.modules.t3localserver.LinuxMaintenance
import expo.modules.t3localserver.LocalServerState
import expo.modules.t3localserver.LocalServerStatusStore
import expo.modules.t3localserver.ServerHealth
import expo.modules.t3localserver.ServerSwitchActivity
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

private const val THIS_PHONE_PATH = "/settings/this-phone"

private fun dot(tone: String) = when (tone) {
  "needs" -> R.drawable.t3w_dot_needs
  "working" -> R.drawable.t3w_dot_working
  "failed" -> R.drawable.t3w_dot_failed
  "done" -> R.drawable.t3w_dot_done
  else -> R.drawable.t3w_dot_idle
}

private fun RemoteViews.show(id: Int, visible: Boolean) = setViewVisibility(id, if (visible) View.VISIBLE else View.GONE)

// ---- Working threads and Recent threads ----------------------------------------------------

data class ThreadRow(val title: String, val sub: String, val tone: String, val status: String, val needsYou: Boolean, val path: String)

data class ThreadsWidgetModel(
  val kind: WidgetKind,
  val icon: Int,
  val count: String,
  val rows: List<ThreadRow>,
  val empty: String,
  val stamp: String?,
  val compact: Boolean,
) : WidgetModel {
  override fun views(context: Context): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.t3w_threads)
    val home = HomeWidgets.openApp(context, "/")
    views.show(R.id.t3w_header, !compact)
    views.setImageViewResource(R.id.t3w_icon, icon)
    views.setTextViewText(R.id.t3w_title, if (kind == WidgetKind.WORKING) "Working" else "Recent threads")
    views.setTextViewText(R.id.t3w_count, count)
    views.setOnClickPendingIntent(R.id.t3w_header, home)
    views.setOnClickPendingIntent(R.id.t3w_root, home)
    for (slot in 0 until WidgetSizing.MAX_ROWS) {
      val ids = SLOTS[slot]
      val row = rows.getOrNull(slot)
      views.show(ids[0], row != null)
      if (row == null) continue
      views.setImageViewResource(ids[1], dot(row.tone))
      views.setTextViewText(ids[2], row.title)
      views.setTextViewText(ids[3], if (compact && stamp != null) stamp else row.sub)
      views.show(ids[4], row.needsYou)
      views.show(ids[5], kind == WidgetKind.RECENT && !row.needsYou && row.status.isNotEmpty())
      views.setTextViewText(ids[5], row.status)
      views.setContentDescription(ids[0], listOf(row.title, if (row.needsYou) "Needs you" else row.status, row.sub).filter { it.isNotEmpty() }.joinToString(", "))
      views.setOnClickPendingIntent(ids[0], HomeWidgets.openApp(context, row.path))
    }
    views.show(R.id.t3w_empty, rows.isEmpty())
    views.setTextViewText(R.id.t3w_empty, if (compact && stamp != null && rows.isEmpty()) "$empty · $stamp" else empty)
    views.show(R.id.t3w_stamp, stamp != null && !compact)
    views.setTextViewText(R.id.t3w_stamp, stamp ?: "")
    return views
  }

  companion object {
    private val SLOTS = arrayOf(
      intArrayOf(R.id.t3w_row0, R.id.t3w_row0_dot, R.id.t3w_row0_title, R.id.t3w_row0_sub, R.id.t3w_row0_badge, R.id.t3w_row0_status),
      intArrayOf(R.id.t3w_row1, R.id.t3w_row1_dot, R.id.t3w_row1_title, R.id.t3w_row1_sub, R.id.t3w_row1_badge, R.id.t3w_row1_status),
      intArrayOf(R.id.t3w_row2, R.id.t3w_row2_dot, R.id.t3w_row2_title, R.id.t3w_row2_sub, R.id.t3w_row2_badge, R.id.t3w_row2_status),
      intArrayOf(R.id.t3w_row3, R.id.t3w_row3_dot, R.id.t3w_row3_title, R.id.t3w_row3_sub, R.id.t3w_row3_badge, R.id.t3w_row3_status),
      intArrayOf(R.id.t3w_row4, R.id.t3w_row4_dot, R.id.t3w_row4_title, R.id.t3w_row4_sub, R.id.t3w_row4_badge, R.id.t3w_row4_status),
      intArrayOf(R.id.t3w_row5, R.id.t3w_row5_dot, R.id.t3w_row5_title, R.id.t3w_row5_sub, R.id.t3w_row5_badge, R.id.t3w_row5_status),
    )

    fun from(context: Context, kind: WidgetKind, size: WidgetSize): ThreadsWidgetModel {
      val data = HomeWidgets.read(context, "threads")
      val section = data?.json?.optJSONObject(if (kind == WidgetKind.WORKING) "working" else "recent")
      val list = section?.optJSONArray("rows")
      val limit = WidgetSizing.threadRows(size.heightDp)
      val rows = (0 until (list?.length() ?: 0)).mapNotNull { list?.optJSONObject(it) }.take(limit).map {
        ThreadRow(
          title = it.optString("title"),
          sub = it.optString("sub"),
          tone = it.optString("tone"),
          status = it.optString("status"),
          needsYou = it.optBoolean("needsYou"),
          path = it.optString("path", "/"),
        )
      }
      val empty = when {
        data == null -> context.getString(R.string.t3w_loading)
        kind == WidgetKind.WORKING -> "Nothing running"
        else -> "No threads yet"
      }
      return ThreadsWidgetModel(
        kind = kind,
        icon = WidgetIcon.resource(context),
        count = section?.optString("count").orEmpty(),
        rows = rows,
        empty = empty,
        stamp = data?.stamp(),
        compact = WidgetSizing.isCompact(size.heightDp),
      )
    }
  }
}

// ---- This phone's server -------------------------------------------------------------------

enum class ServerButton { START, SETUP, STOP, BUSY }

data class ServerWidgetModel(
  val compact: Boolean,
  /** Under two launcher rows: the web server line and the detail line do not both fit. */
  val short: Boolean,
  val icon: Int,
  val status: String,
  val tone: String,
  val button: ServerButton,
  val detail: String?,
  val memory: String?,
  val webLabel: String?,
  val webUrl: String?,
) : WidgetModel {
  override fun views(context: Context): RemoteViews {
    val views = RemoteViews(context.packageName, if (compact) R.layout.t3w_server_small else R.layout.t3w_server)
    val thisPhone = HomeWidgets.openApp(context, THIS_PHONE_PATH)
    views.setOnClickPendingIntent(R.id.t3w_root, thisPhone)
    views.setImageViewResource(R.id.t3w_icon, icon)
    views.setImageViewResource(R.id.t3w_status_dot, dot(tone))
    // Memory gets its own line when there is room; the uppercase header leaves little beside it.
    val inline = memory != null && (compact || (short && webUrl != null))
    views.setTextViewText(R.id.t3w_status, if (inline) "$status · $memory" else status)
    val primary = button == ServerButton.START || button == ServerButton.SETUP
    views.show(R.id.t3w_start, primary)
    views.show(R.id.t3w_stop, !primary)
    when (button) {
      ServerButton.START -> {
        views.setTextViewText(R.id.t3w_start, "Start")
        views.setOnClickPendingIntent(R.id.t3w_start, switch(context, ServerSwitchActivity.ACTION_START))
      }
      ServerButton.SETUP -> {
        views.setTextViewText(R.id.t3w_start, "Set up")
        views.setOnClickPendingIntent(R.id.t3w_start, thisPhone)
      }
      ServerButton.STOP -> {
        views.setTextViewText(R.id.t3w_stop, "Stop")
        views.setOnClickPendingIntent(R.id.t3w_stop, switch(context, ServerSwitchActivity.ACTION_STOP))
      }
      ServerButton.BUSY -> {
        views.setTextViewText(R.id.t3w_stop, "Busy")
        views.setOnClickPendingIntent(R.id.t3w_stop, thisPhone)
      }
    }
    if (!compact) {
      views.show(R.id.t3w_detail, detail != null && !(short && webUrl != null))
      views.setTextViewText(R.id.t3w_detail, detail ?: "")
      views.show(R.id.t3w_web, webUrl != null)
      if (webUrl != null) {
        views.setTextViewText(R.id.t3w_web_text, webLabel)
        views.setOnClickPendingIntent(R.id.t3w_web_open, HomeWidgets.openUrl(context, webUrl))
      }
    }
    return views
  }

  private fun switch(context: Context, action: String) = PendingIntent.getActivity(
    context,
    action.hashCode(),
    ServerSwitchActivity.intent(context, action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  companion object {
    fun from(context: Context, size: WidgetSize): ServerWidgetModel {
      val status = LocalServerStatusStore.resolve(context)
      val busy = LinuxMaintenance.busy
      val (label, tone) = when {
        busy -> "Busy" to "idle"
        else -> when (status.state) {
          LocalServerState.NOT_INSTALLED -> "Not set up" to "idle"
          LocalServerState.INSTALLING -> "Setting up…" to "working"
          LocalServerState.STARTING -> "Starting" to "working"
          LocalServerState.RUNNING -> "Running" to "done"
          LocalServerState.STOPPED -> "Stopped" to "idle"
          LocalServerState.FAILED -> "Failed" to "failed"
        }
      }
      val button = when {
        busy -> ServerButton.BUSY
        status.state == LocalServerState.NOT_INSTALLED -> ServerButton.SETUP
        status.state == LocalServerState.STOPPED || status.state == LocalServerState.FAILED -> ServerButton.START
        else -> ServerButton.STOP
      }
      val running = status.state == LocalServerState.RUNNING
      val detail = when {
        busy -> "Backing up or restoring Linux"
        running -> ServerWidgetWatcher.memory()?.let { "Memory $it" }
        status.state == LocalServerState.NOT_INSTALLED -> "Run agents on this phone"
        status.state == LocalServerState.FAILED -> status.detail.lineSequence().firstOrNull()?.take(80)?.ifEmpty { null }
        else -> null
      }
      val web = if (running) DevServers.current.maxByOrNull { it.since } else null
      return ServerWidgetModel(
        compact = WidgetSizing.isCompact(size.heightDp),
        short = WidgetSizing.isShort(size.heightDp),
        icon = WidgetIcon.resource(context),
        status = label,
        tone = if (running) "done" else tone,
        button = button,
        detail = detail,
        memory = if (running) ServerWidgetWatcher.memory() else null,
        webLabel = web?.let { WidgetText.webServer(it.url, it.command) },
        webUrl = web?.url,
      )
    }
  }
}

/** Keeps the server widget in step with the server, and its memory figure roughly current. */
object ServerWidgetWatcher {
  private const val MEMORY_MILLIS = 120_000L
  private val started = AtomicBoolean(false)
  private val ticking = AtomicBoolean(false)
  private val waitingForScreen = AtomicBoolean(false)
  @Volatile private var memoryBytes: Long? = null
  @Volatile private var memoryAt = 0L
  @Volatile private var totalBytes = 0L

  fun start(context: Context) {
    if (!started.compareAndSet(false, true)) return
    val app = context.applicationContext
    LocalServerStatusStore.addListener { HomeWidgets.refresh(app, *WidgetKind.SERVER_STATE, *WidgetKind.WEB_SERVER) }
    LinuxMaintenance.addListener { HomeWidgets.refresh(app, WidgetKind.SERVER) }
    DevServers.addListener { HomeWidgets.refresh(app, *WidgetKind.WEB_SERVER) }
  }

  /** Sampled at most every two minutes; reading every guest's /proc entry is not free. */
  fun memoryBytes(): Long? {
    val now = System.currentTimeMillis()
    if (memoryBytes == null || now - memoryAt >= MEMORY_MILLIS - 5_000) {
      memoryBytes = runCatching { ServerHealth.tree().rssBytes }.getOrNull()?.takeIf { it > 0 }
      memoryAt = now
    }
    return memoryBytes
  }

  fun memory(): String? = memoryBytes()?.let(WidgetText::memory)

  /** The server's share of the phone's RAM, in whole percent so small swings do not redraw. */
  fun memoryShare(context: Context): Float? {
    val used = memoryBytes() ?: return null
    if (totalBytes == 0L) {
      val info = ActivityManager.MemoryInfo()
      context.getSystemService(ActivityManager::class.java)?.getMemoryInfo(info)
      totalBytes = info.totalMem
    }
    if (totalBytes <= 0L) return null
    return (used * 100 / totalBytes).coerceIn(1, 100) / 100f
  }

  /** Re-samples memory while the server runs and the screen is on; nothing runs otherwise. */
  fun afterRender(context: Context) {
    val running = LocalServerStatusStore.resolve(context).state == LocalServerState.RUNNING
    if (!running) {
      memoryBytes = null
      return
    }
    if (!ticking.compareAndSet(false, true)) return
    HomeWidgets.postDelayed(MEMORY_MILLIS) {
      ticking.set(false)
      val power = context.getSystemService(PowerManager::class.java)
      if (power?.isInteractive == false) waitForScreen(context) else HomeWidgets.refresh(context, *WidgetKind.SERVER_STATE)
    }
  }

  private fun waitForScreen(context: Context) {
    if (!waitingForScreen.compareAndSet(false, true)) return
    context.applicationContext.registerReceiver(
      object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context, intent: Intent) {
          receiverContext.applicationContext.unregisterReceiver(this)
          waitingForScreen.set(false)
          HomeWidgets.refresh(receiverContext, *WidgetKind.SERVER_STATE)
        }
      },
      IntentFilter(Intent.ACTION_SCREEN_ON),
    )
  }
}

// ---- Quick actions -------------------------------------------------------------------------

data class ActionsWidgetModel(val icon: Int, val labels: Boolean, val webUrl: String?, val webLabel: String?) : WidgetModel {
  override fun views(context: Context): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.t3w_actions)
    views.setImageViewResource(R.id.t3w_new_icon, icon)
    views.setOnClickPendingIntent(R.id.t3w_new, HomeWidgets.openApp(context, "/new"))
    views.setOnClickPendingIntent(R.id.t3w_shell, HomeWidgets.openApp(context, "/settings/this-phone/shell"))
    views.show(R.id.t3w_web, webUrl != null)
    if (webUrl != null) {
      views.setOnClickPendingIntent(R.id.t3w_web, HomeWidgets.openUrl(context, webUrl))
      views.setTextViewText(R.id.t3w_web_label, webLabel)
      views.setContentDescription(R.id.t3w_web, "Open $webLabel")
    }
    for (label in intArrayOf(R.id.t3w_new_label, R.id.t3w_shell_label, R.id.t3w_web_label)) views.show(label, labels)
    return views
  }

  companion object {
    fun from(context: Context, size: WidgetSize): ActionsWidgetModel {
      val running = LocalServerStatusStore.resolve(context).state == LocalServerState.RUNNING
      val web = if (running) DevServers.current.maxByOrNull { it.since } else null
      return ActionsWidgetModel(
        icon = WidgetIcon.resource(context),
        labels = WidgetSizing.showActionLabels(size.widthDp, size.heightDp, if (web == null) 2 else 3),
        webUrl = web?.url,
        webLabel = web?.let { WidgetText.port(it.url) },
      )
    }
  }
}

// ---- Usage today ---------------------------------------------------------------------------

data class UsageWidgetModel(
  val compact: Boolean,
  val icon: Int,
  val tokens: String?,
  val busiest: String,
  val stamp: String?,
  val path: String,
) : WidgetModel {
  override fun views(context: Context): RemoteViews {
    val views = RemoteViews(context.packageName, if (compact) R.layout.t3w_usage_small else R.layout.t3w_usage)
    views.setImageViewResource(R.id.t3w_icon, icon)
    views.setOnClickPendingIntent(R.id.t3w_root, HomeWidgets.openApp(context, path))
    if (compact) {
      views.setTextViewText(R.id.t3w_tokens, tokens?.let { "$it tokens today" } ?: "Usage today")
      views.setTextViewText(R.id.t3w_busiest, stamp ?: busiest)
    } else {
      views.setTextViewText(R.id.t3w_tokens, tokens ?: "–")
      views.setTextViewText(R.id.t3w_busiest, busiest)
      views.show(R.id.t3w_stamp, stamp != null)
      views.setTextViewText(R.id.t3w_stamp, stamp ?: "")
    }
    return views
  }

  companion object {
    private const val DAY_MILLIS = 24 * 60 * 60_000L

    /** Totals belong to one local day; a day later they would be wrong, not just old. */
    fun today(data: StoredData?): JSONObject? =
      data?.json?.takeIf { System.currentTimeMillis() - it.optLong("since") < DAY_MILLIS }

    fun from(context: Context, size: WidgetSize): UsageWidgetModel {
      val data = HomeWidgets.read(context, "usage")
      val json = today(data)
      return UsageWidgetModel(
        compact = WidgetSizing.isCompact(size.heightDp),
        icon = WidgetIcon.resource(context),
        tokens = json?.optString("tokens")?.ifEmpty { null },
        busiest = json?.optString("detail")?.ifEmpty { null } ?: context.getString(R.string.t3w_loading),
        stamp = if (json != null) data?.stamp() else null,
        path = json?.optString("path")?.ifEmpty { null } ?: "/",
      )
    }
  }
}

// ---- New thread bar ------------------------------------------------------------------------

data class PromptWidgetModel(val icon: Int, val webUrl: String?, val webLabel: String?) : WidgetModel {
  override fun views(context: Context): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.t3w_prompt)
    views.setImageViewResource(R.id.t3w_icon, icon)
    views.setOnClickPendingIntent(R.id.t3w_new, HomeWidgets.openApp(context, "/new"))
    views.setOnClickPendingIntent(R.id.t3w_shell, HomeWidgets.openApp(context, "/settings/this-phone/shell"))
    views.show(R.id.t3w_web, webUrl != null)
    if (webUrl != null) {
      views.setOnClickPendingIntent(R.id.t3w_web, HomeWidgets.openUrl(context, webUrl))
      views.setContentDescription(R.id.t3w_web, "Open $webLabel")
    }
    return views
  }

  companion object {
    fun from(context: Context): PromptWidgetModel {
      val running = LocalServerStatusStore.resolve(context).state == LocalServerState.RUNNING
      val web = if (running) DevServers.current.maxByOrNull { it.since } else null
      return PromptWidgetModel(WidgetIcon.resource(context), web?.url, web?.let { WidgetText.port(it.url) })
    }
  }
}

// ---- Gauges and the status line ------------------------------------------------------------

/** Active thread totals from the app's data; null until the app has published any. */
data class ActiveThreads(val total: Int, val needs: Int, val stamp: String?) {
  companion object {
    fun read(context: Context): ActiveThreads? {
      val data = HomeWidgets.read(context, "threads") ?: return null
      val active = data.json.optJSONObject("active")
      val rows = data.json.optJSONObject("working")?.optJSONArray("rows")
      val total = active?.optInt("total") ?: rows?.length() ?: 0
      val needs = active?.optInt("needs")
        ?: (0 until (rows?.length() ?: 0)).count { rows?.optJSONObject(it)?.optBoolean("needsYou") == true }
      return ActiveThreads(total, needs, data.stamp())
    }
  }
}

/** The server as the one-line widgets name it: label, dot tone, and memory while it runs. */
data class ServerLine(val label: String, val tone: String, val memory: String?, val share: Float?) {
  companion object {
    fun read(context: Context): ServerLine {
      val state = LocalServerStatusStore.resolve(context).state
      if (LinuxMaintenance.busy) return ServerLine("Busy", "working", null, null)
      return when (state) {
        LocalServerState.RUNNING -> ServerLine("Running", "done", ServerWidgetWatcher.memory(), ServerWidgetWatcher.memoryShare(context))
        LocalServerState.STARTING -> ServerLine("Starting", "working", null, null)
        LocalServerState.INSTALLING -> ServerLine("Setting up", "working", null, null)
        LocalServerState.FAILED -> ServerLine("Failed", "failed", null, null)
        LocalServerState.STOPPED -> ServerLine("Off", "idle", null, null)
        LocalServerState.NOT_INSTALLED -> ServerLine("Not set up", "idle", null, null)
      }
    }
  }
}

/** Arcs like One UI's battery gauges: a dark track open at the bottom, filled clockwise. */
object Gauge {
  private const val START = 140f
  private const val SWEEP = 260f
  private const val SIZE_DP = 64

  fun bitmap(context: Context, segments: List<Pair<Float, Int>>): Bitmap {
    val px = (SIZE_DP * context.resources.displayMetrics.density).roundToInt()
    val bitmap = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val stroke = px * 0.1f
    val bounds = RectF(stroke / 2, stroke / 2, px - stroke / 2, px - stroke / 2)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = stroke
      strokeCap = Paint.Cap.ROUND
      color = context.getColor(R.color.t3w_track)
    }
    canvas.drawArc(bounds, START, SWEEP, false, paint)
    var at = START
    for ((fraction, color) in segments) {
      val sweep = SWEEP * fraction.coerceIn(0f, 1f)
      if (sweep <= 0f) continue
      paint.color = color
      canvas.drawArc(bounds, at, sweep, false, paint)
      at += sweep
    }
    return bitmap
  }
}

data class GaugesWidgetModel(val server: ServerLine, val threads: ActiveThreads?) : WidgetModel {
  override fun views(context: Context): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.t3w_gauges)
    val share = server.share
    val memoryColor = when {
      share == null || share < 0.6f -> R.color.t3w_done
      share < 0.8f -> R.color.t3w_needs
      else -> R.color.t3w_failed
    }
    views.setImageViewBitmap(
      R.id.t3w_memory_arc,
      Gauge.bitmap(context, if (share == null) emptyList() else listOf(share to context.getColor(memoryColor))),
    )
    val memoryLabel = server.memory?.replace(" MB", "M")?.replace(" GB", "G") ?: server.label
    views.setTextViewText(R.id.t3w_memory_label, memoryLabel)
    views.setContentDescription(R.id.t3w_memory, "Server ${server.label}${server.memory?.let { ", $it" } ?: ""}")
    views.setOnClickPendingIntent(R.id.t3w_memory, HomeWidgets.openApp(context, THIS_PHONE_PATH))

    // The whole arc splits between threads that need the user and threads that are working.
    val segments = if (threads == null || threads.total == 0) emptyList() else listOf(
      threads.needs.toFloat() / threads.total to context.getColor(R.color.t3w_needs),
      (threads.total - threads.needs).toFloat() / threads.total to context.getColor(R.color.t3w_working),
    )
    views.setImageViewBitmap(R.id.t3w_threads_arc, Gauge.bitmap(context, segments))
    views.setTextViewText(R.id.t3w_threads_label, threads?.total?.toString() ?: "–")
    views.setContentDescription(R.id.t3w_threads, threads?.let { WidgetText.activeThreads(it.total, it.needs) } ?: "Agents")
    views.setOnClickPendingIntent(R.id.t3w_threads, HomeWidgets.openApp(context, "/"))
    views.setOnClickPendingIntent(R.id.t3w_root, HomeWidgets.openApp(context, "/"))
    return views
  }

  companion object {
    fun from(context: Context) = GaugesWidgetModel(ServerLine.read(context), ActiveThreads.read(context))
  }
}

data class StatusWidgetModel(val server: ServerLine, val threads: ActiveThreads?) : WidgetModel {
  override fun views(context: Context): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.t3w_status)
    val tone = when {
      threads == null -> "idle"
      threads.needs > 0 -> "needs"
      threads.total > 0 -> "working"
      else -> "idle"
    }
    views.setImageViewResource(R.id.t3w_threads_dot, dot(tone))
    views.setTextViewText(
      R.id.t3w_threads_text,
      threads?.let { WidgetText.activeThreads(it.total, it.needs) } ?: context.getString(R.string.t3w_loading),
    )
    val stamp = threads?.stamp?.removePrefix("Updated ")
    views.show(R.id.t3w_stamp, stamp != null)
    views.setTextViewText(R.id.t3w_stamp, stamp ?: "")
    views.setOnClickPendingIntent(R.id.t3w_threads, HomeWidgets.openApp(context, "/"))
    views.setImageViewResource(R.id.t3w_server_dot, dot(server.tone))
    views.setTextViewText(R.id.t3w_server_text, "Server ${server.memory ?: server.label.lowercase()}")
    views.setContentDescription(R.id.t3w_server, "Server ${server.label}${server.memory?.let { ", $it" } ?: ""}")
    views.setOnClickPendingIntent(R.id.t3w_server, HomeWidgets.openApp(context, THIS_PHONE_PATH))
    views.setOnClickPendingIntent(R.id.t3w_root, HomeWidgets.openApp(context, "/"))
    return views
  }

  companion object {
    fun from(context: Context) = StatusWidgetModel(ServerLine.read(context), ActiveThreads.read(context))
  }
}

/** Arc colour for how much of something is left: green, then orange, then red. */
private fun remainingColor(remaining: Int) = when {
  remaining > 30 -> R.color.t3w_done
  remaining > 10 -> R.color.t3w_needs
  else -> R.color.t3w_failed
}

// ---- Limits --------------------------------------------------------------------------------

data class LimitGauge(val tag: String, val name: String, val remaining: Int)

data class LimitsWidgetModel(val gauges: List<LimitGauge>, val empty: String?, val path: String) : WidgetModel {
  override fun views(context: Context): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.t3w_limits)
    views.setOnClickPendingIntent(R.id.t3w_root, HomeWidgets.openApp(context, path))
    views.show(R.id.t3w_empty, empty != null)
    views.setTextViewText(R.id.t3w_empty, empty ?: "")
    SLOTS.forEachIndexed { index, ids ->
      val gauge = gauges.getOrNull(index)
      views.show(ids[0], gauge != null)
      if (gauge == null) return@forEachIndexed
      val remaining = gauge.remaining
      views.setImageViewBitmap(ids[1], Gauge.bitmap(context, listOf(remaining / 100f to context.getColor(remainingColor(remaining)))))
      views.setTextViewText(ids[2], gauge.tag)
      views.setTextViewText(ids[3], "$remaining%")
      views.setContentDescription(ids[0], "${gauge.name}: $remaining% left")
    }
    return views
  }

  companion object {
    private const val GAUGE_WIDTH_DP = 68

    private val SLOTS = listOf(
      intArrayOf(R.id.t3w_limit_0, R.id.t3w_limit_0_arc, R.id.t3w_limit_0_tag, R.id.t3w_limit_0_label),
      intArrayOf(R.id.t3w_limit_1, R.id.t3w_limit_1_arc, R.id.t3w_limit_1_tag, R.id.t3w_limit_1_label),
      intArrayOf(R.id.t3w_limit_2, R.id.t3w_limit_2_arc, R.id.t3w_limit_2_tag, R.id.t3w_limit_2_label),
      intArrayOf(R.id.t3w_limit_3, R.id.t3w_limit_3_arc, R.id.t3w_limit_3_tag, R.id.t3w_limit_3_label),
    )

    fun from(context: Context, size: WidgetSize): LimitsWidgetModel {
      val json = HomeWidgets.read(context, "limits")?.json
        ?: return LimitsWidgetModel(emptyList(), context.getString(R.string.t3w_loading), "/")
      val now = System.currentTimeMillis()
      val array = json.optJSONArray("gauges")
      val fits = if (size.widthDp <= 0) SLOTS.size else (size.widthDp / GAUGE_WIDTH_DP).coerceIn(1, SLOTS.size)
      val gauges = (0 until (array?.length() ?: 0)).mapNotNull { array?.optJSONObject(it) }.take(fits).map {
        val resetAt = it.optLong("resetAt")
        LimitGauge(
          tag = it.optString("tag"),
          name = it.optString("name"),
          remaining = if (resetAt in 1..now) 100 else it.optInt("remaining"),
        )
      }
      return LimitsWidgetModel(
        gauges = gauges,
        empty = if (gauges.isEmpty()) json.optString("empty").ifEmpty { "No limits available" } else null,
        path = json.optString("path").ifEmpty { "/" },
      )
    }
  }
}

// ---- Tokens today --------------------------------------------------------------------------

data class TokensWidgetModel(
  val tokens: String?,
  /** Today's tokens over the average of the six days before; null when there is nothing to compare. */
  val ratio: Float?,
  val detail: String,
  val path: String,
) : WidgetModel {
  override fun views(context: Context): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.t3w_tokens)
    // Under the average stays green, up to half again is orange, beyond that red.
    val color = when {
      ratio == null || ratio < 1f -> R.color.t3w_done
      ratio < 1.5f -> R.color.t3w_needs
      else -> R.color.t3w_failed
    }
    views.setImageViewBitmap(R.id.t3w_tokens_arc, Gauge.bitmap(context, listOf((ratio ?: 0f) to context.getColor(color))))
    views.setTextViewText(R.id.t3w_tokens_label, tokens ?: "–")
    views.setTextViewText(
      R.id.t3w_compare,
      when {
        tokens == null -> context.getString(R.string.t3w_loading)
        ratio == null -> "No earlier days to compare"
        else -> "${(ratio * 100).roundToInt()}% of a usual day"
      },
    )
    views.setTextViewText(R.id.t3w_busiest, detail)
    views.setOnClickPendingIntent(R.id.t3w_root, HomeWidgets.openApp(context, path))
    return views
  }

  companion object {
    fun from(context: Context): TokensWidgetModel {
      val data = HomeWidgets.read(context, "usage")
      val json = UsageWidgetModel.today(data)
      val today = json?.optDouble("todayTokens", Double.NaN) ?: Double.NaN
      val average = json?.optDouble("averageTokens", Double.NaN) ?: Double.NaN
      return TokensWidgetModel(
        tokens = json?.optString("tokens")?.ifEmpty { null },
        ratio = if (today.isNaN() || average.isNaN() || average <= 0.0) null else (today / average).toFloat(),
        detail = (if (json != null) data?.stamp() else null) ?: json?.optString("detail")?.ifEmpty { null } ?: "",
        path = json?.optString("path")?.ifEmpty { null } ?: "/",
      )
    }
  }
}
