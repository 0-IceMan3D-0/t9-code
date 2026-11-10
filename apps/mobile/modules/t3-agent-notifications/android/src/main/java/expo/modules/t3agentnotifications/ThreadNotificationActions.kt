package expo.modules.t3agentnotifications

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.t3appicon.AppIconStyle

/** Approve, Deny, option and Reply taps. Shows progress at once, then hands off to JS. */
class ThreadNotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ThreadNotifications.ACTION_EXPIRED) {
      val group = intent.getStringExtra("group") ?: return
      ThreadNotifications.cardRemoved(context, group, intent.getStringExtra("resultTag"))
      return
    }
    val tag = intent.getStringExtra("tag") ?: return
    val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(ThreadNotifications.REPLY_KEY)
      ?.toString()?.trim()
    val action = intent.getStringExtra("action")
    if (action == "reply" && text.isNullOrEmpty()) return
    ThreadNotifications.showProgress(
      context,
      tag,
      intent.getStringExtra("progress")?.takeIf { it.isNotEmpty() } ?: "Sending…"
    )
    val task = Intent(context, ThreadNotificationActionService::class.java).putExtras(intent)
    if (text != null) task.putExtra("text", text)
    try {
      context.startService(task)
    } catch (_: IllegalStateException) {
      ThreadNotifications.showResult(context, tag, "Open T3² Code to respond.", false)
    }
  }
}

/** Runs the action in JS, starting React Native in the background when the app is closed. */
class ThreadNotificationActionService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val extras = intent?.extras ?: return null
    return HeadlessJsTaskConfig(ACTION_TASK, Arguments.fromBundle(extras), ACTION_TIMEOUT_MS, true)
  }

  override fun onDestroy() {
    ThreadNotifications.failPendingActions(this)
    super.onDestroy()
  }

  companion object {
    const val ACTION_TASK = "T3ThreadNotificationAction"
    private const val ACTION_TIMEOUT_MS = 60_000L
  }
}

/**
 * React Native pauses JS timers while no activity is resumed, so a dropped socket would not
 * reconnect in the background. A headless task resumes them for a bounded window.
 */
object JsTimerWindow {
  private const val TASK = "T3NotificationTimerWindow"
  private var openUntil = 0L

  fun open(context: Context, timeoutMs: Long) {
    UiThreadUtil.runOnUiThread {
      val now = System.currentTimeMillis()
      if (now < openUntil) return@runOnUiThread
      val host = (context.applicationContext as? ReactApplication)?.reactHost ?: return@runOnUiThread
      openUntil = now + timeoutMs
      val current = host.currentReactContext
      if (current != null) {
        start(current, timeoutMs)
      } else {
        host.addReactInstanceEventListener(object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            host.removeReactInstanceEventListener(this)
            start(context, timeoutMs)
          }
        })
        host.start()
      }
    }
  }

  fun closed() {
    openUntil = 0L
  }

  private fun start(context: ReactContext, timeoutMs: Long) {
    UiThreadUtil.runOnUiThread {
      runCatching {
        HeadlessJsTaskContext.getInstance(context)
          .startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap(), timeoutMs, true))
      }.onFailure { openUntil = 0L }
    }
  }
}

/**
 * Optional "stay connected" mode: a foreground service keeps the process from being frozen or
 * cut off from the network, so the JS watcher keeps receiving events from other servers.
 */
class ThreadWatchService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      ThreadNotifications.writeStore(this, "watchStopRequested", "true")
      ThreadNotifications.settingsListener?.invoke()
      @Suppress("DEPRECATION")
      stopForeground(true)
      stopSelf()
      return START_NOT_STICKY
    }
    ThreadNotifications.channels(this)
    val notification = notification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // A sticky restart after the process died has no JS yet: start it so the watcher runs.
    if (intent == null) JsTimerWindow.open(this, RESTART_WINDOW_MS)
    return START_STICKY
  }

  private fun notification(): Notification {
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val stop = PendingIntent.getService(
      this,
      0,
      Intent(this, ThreadWatchService::class.java).setAction(ACTION_STOP),
      flags
    )
    return NotificationCompat.Builder(this, ThreadNotifications.CHANNEL_WATCH)
      .setSmallIcon(AppIconStyle.smallIcon(this)).addExtras(AppIconStyle.extras())
      .setContentTitle("Staying connected for notifications")
      .setContentText("Turn this off in Settings → Notifications")
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setContentIntent(ThreadNotifications.contentIntent(this, null, NOTIFICATION_ID))
      .addAction(0, "Turn off", stop)
      .build()
  }

  companion object {
    private const val NOTIFICATION_ID = 7303
    private const val ACTION_STOP = "expo.modules.t3agentnotifications.WATCH_STOP"
    private const val RESTART_WINDOW_MS = 90_000L

    fun setRunning(context: Context, running: Boolean): Boolean {
      val intent = Intent(context, ThreadWatchService::class.java)
      return try {
        if (!running) {
          context.stopService(intent)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      } catch (_: IllegalStateException) {
        false
      }
    }

    fun isRunning(context: Context): Boolean =
      context.getSystemService(NotificationManager::class.java).activeNotifications.any {
        it.id == NOTIFICATION_ID
      }
  }
}
