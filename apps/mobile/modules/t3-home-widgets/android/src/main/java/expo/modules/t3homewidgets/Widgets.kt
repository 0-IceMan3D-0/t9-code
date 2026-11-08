package expo.modules.t3homewidgets

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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
  /** About one launcher row: the memory figure joins the status so the button stays visible. */
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
    val inline = (compact || short) && memory != null
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
      views.show(R.id.t3w_detail, detail != null && !(short && (memory != null || webUrl != null)))
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
  @Volatile private var memoryLabel: String? = null
  @Volatile private var memoryAt = 0L

  fun start(context: Context) {
    if (!started.compareAndSet(false, true)) return
    val app = context.applicationContext
    LocalServerStatusStore.addListener { HomeWidgets.refresh(app, WidgetKind.SERVER) }
    LinuxMaintenance.addListener { HomeWidgets.refresh(app, WidgetKind.SERVER) }
    DevServers.addListener { HomeWidgets.refresh(app, WidgetKind.SERVER, WidgetKind.ACTIONS) }
  }

  /** Sampled at most every two minutes; reading every guest's /proc entry is not free. */
  fun memory(): String? {
    val now = System.currentTimeMillis()
    if (memoryLabel == null || now - memoryAt >= MEMORY_MILLIS - 5_000) {
      memoryLabel = runCatching { ServerHealth.tree().rssBytes }.getOrNull()?.takeIf { it > 0 }?.let(WidgetText::memory)
      memoryAt = now
    }
    return memoryLabel
  }

  /** Re-samples memory while the server runs and the screen is on; nothing runs otherwise. */
  fun afterRender(context: Context) {
    val running = LocalServerStatusStore.resolve(context).state == LocalServerState.RUNNING
    if (!running) {
      memoryLabel = null
      return
    }
    if (!ticking.compareAndSet(false, true)) return
    HomeWidgets.postDelayed(MEMORY_MILLIS) {
      ticking.set(false)
      val power = context.getSystemService(PowerManager::class.java)
      if (power?.isInteractive == false) waitForScreen(context) else HomeWidgets.refresh(context, WidgetKind.SERVER)
    }
  }

  private fun waitForScreen(context: Context) {
    if (!waitingForScreen.compareAndSet(false, true)) return
    context.applicationContext.registerReceiver(
      object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context, intent: Intent) {
          receiverContext.applicationContext.unregisterReceiver(this)
          waitingForScreen.set(false)
          HomeWidgets.refresh(receiverContext, WidgetKind.SERVER)
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

    fun from(context: Context, size: WidgetSize): UsageWidgetModel {
      val data = HomeWidgets.read(context, "usage")
      // Totals belong to one local day; a day later they would be wrong, not just old.
      val json: JSONObject? = data?.json?.takeIf { System.currentTimeMillis() - it.optLong("since") < DAY_MILLIS }
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
