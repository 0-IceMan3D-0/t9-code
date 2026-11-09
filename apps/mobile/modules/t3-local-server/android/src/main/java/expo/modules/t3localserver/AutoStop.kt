package expo.modules.t3localserver

import android.app.Activity
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import expo.modules.t3appicon.AppIconStyle
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet

/**
 * "Stop when I leave the app": once the app's own screens are all stopped, waits out the chosen
 * delay, then stops the built-in server unless something still uses it. Runs on the main
 * looper, which keeps going in the background because the server's service holds a wake lock.
 */
object AutoStop {
  private const val POLL_MILLIS = 15_000L
  private const val NOTICE_ID = 3786

  // Translucent tile and shortcut activities are not "the app"; starting from them must not arm this.
  private val SWITCH_ACTIVITIES = setOf(ServerSwitchActivity::class.java, ThisPhoneActivity::class.java)

  private val handler = Handler(Looper.getMainLooper())
  private val listeners = CopyOnWriteArraySet<() -> Unit>()
  private var app: Context? = null
  private var visibleScreens = 0
  private var leftAt: Long? = null
  private var clearedAt: Long? = null
  private var wasBlocked = false
  private var keepRunning = false
  private var stoppedByUs = false
  private var serverWasUp = false

  @Volatile
  private var threads = AutoStopWork(threadsUnknown = true)

  @Volatile
  var decision: AutoStopDecision = AutoStopDecision.Idle
    private set

  private val tick = Runnable { evaluate() }

  fun addListener(listener: () -> Unit) = listeners.add(listener)

  fun removeListener(listener: () -> Unit) = listeners.remove(listener)

  /** Idempotent. Only the React module calls it: a tile start in a cold process has no app UI. */
  fun install(context: Context) {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      handler.post { install(context) }
      return
    }
    if (app != null) return
    val application = context.applicationContext as Application
    app = application
    // The module is created after the first activity started, so seed from the process state.
    if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) visibleScreens = 1
    application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityStarted(activity: Activity) {
        if (activity.javaClass in SWITCH_ACTIVITIES) return
        if (visibleScreens++ == 0) returned()
      }

      override fun onActivityStopped(activity: Activity) {
        if (activity.javaClass in SWITCH_ACTIVITIES || activity.isChangingConfigurations) return
        visibleScreens = (visibleScreens - 1).coerceAtLeast(0)
        if (visibleScreens == 0) left()
      }

      override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
      override fun onActivityResumed(activity: Activity) = Unit
      override fun onActivityPaused(activity: Activity) = Unit
      override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    })
    LocalServerStatusStore.addListener { post() }
    LinuxMaintenance.addListener { post() }
    DevServers.addListener { post() }
  }

  /** From JS: `{"known": bool, "working": n, "needsYou": n}` for the built-in server's threads. */
  fun reportThreads(json: String) {
    val value = runCatching { JSONObject(json) }.getOrNull() ?: return
    threads = if (!value.optBoolean("known")) {
      AutoStopWork(threadsUnknown = true)
    } else {
      AutoStopWork(threadsWorking = value.optInt("working"), threadsNeedingYou = value.optInt("needsYou"))
    }
    post()
  }

  /** The React context is gone, so nothing reports threads any more. */
  fun forgetThreads() {
    threads = AutoStopWork(threadsUnknown = true)
    post()
  }

  /** "Keep running" on the notification: holds until the app is next left. */
  fun keepRunning() {
    keepRunning = true
    post()
  }

  fun optionChanged() = post()

  private fun post() {
    handler.post { evaluate() }
  }

  private fun left() {
    leftAt = SystemClock.elapsedRealtime()
    clearedAt = null
    wasBlocked = false
    keepRunning = false
    evaluate()
  }

  private fun returned() {
    leftAt = null
    keepRunning = false
    val context = app ?: return
    context.notificationManager().cancel(NOTICE_ID)
    if (stoppedByUs) {
      stoppedByUs = false
      val state = LocalServerStatusStore.current?.state
      val idle = state == null || state == LocalServerState.STOPPED
      if (idle && LocalServerOptions(context).startOnAppOpen && GuestRuntime(context).isInstalled && !LinuxMaintenance.busy) {
        runCatching { LocalServerService.start(context) }
      }
    }
    evaluate()
  }

  private fun currentWork(): AutoStopWork {
    val shells = if (LinuxShells.ids().isEmpty()) 0 else LinuxShells.describe().count { it["busy"] == true }
    return threads.copy(
      busyShells = shells,
      webServerPorts = DevServers.current.map { it.port }.distinct(),
      maintenance = LinuxMaintenance.busy,
      serverStarting = LocalServerStatusStore.current?.state == LocalServerState.STARTING,
    )
  }

  private fun evaluate() {
    val context = app ?: return
    handler.removeCallbacks(tick)
    val state = LocalServerStatusStore.current?.state
    val serverUp = state == LocalServerState.RUNNING || state == LocalServerState.STARTING
    // A server started from the tile or a shortcut while away is not one the person left running.
    if (serverUp && !serverWasUp) leftAt = null
    serverWasUp = serverUp
    val options = LocalServerOptions(context)
    val armed = serverUp && !keepRunning && leftAt != null && options.stopOnLeave
    val now = SystemClock.elapsedRealtime()
    val work = if (armed) currentWork() else AutoStopWork()
    if (armed && work.blocked) {
      wasBlocked = true
    } else if (armed && wasBlocked) {
      wasBlocked = false
      clearedAt = now
    }
    val next = AutoStopPolicy.decide(armed, now, leftAt, clearedAt, work, options.stopAfterMinutes * 60_000L)
    when (next) {
      is AutoStopDecision.Stop -> {
        stoppedByUs = true
        setDecision(AutoStopDecision.Idle)
        LocalServerService.stop(context)
        postNotice(context)
        return
      }
      is AutoStopDecision.Waiting -> handler.postDelayed(tick, POLL_MILLIS)
      is AutoStopDecision.Countdown -> handler.postDelayed(tick, minOf(POLL_MILLIS, next.stopAt - now))
      AutoStopDecision.Idle -> Unit
    }
    setDecision(next)
  }

  private fun setDecision(next: AutoStopDecision) {
    if (next == decision) return
    decision = next
    listeners.forEach { it() }
  }

  private fun postNotice(context: Context) {
    val builder =
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
        Notification.Builder(context, LocalServerService.CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
    val notification = builder
      .setSmallIcon(AppIconStyle.smallIcon(context)).addExtras(AppIconStyle.extras())
      .setColor(AppIconStyle.accent(context))
      .setContentTitle("Built-in server stopped")
      .setContentText("You left the app and nothing was using it.")
      .setContentIntent(LocalServerService.openAppIntent(context))
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .build()
    context.notificationManager().notify(NOTICE_ID, notification)
  }

  private fun Context.notificationManager() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
}
