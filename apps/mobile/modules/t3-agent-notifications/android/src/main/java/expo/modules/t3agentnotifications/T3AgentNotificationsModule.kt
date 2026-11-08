package expo.modules.t3agentnotifications

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3AgentNotificationsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3AgentNotifications")

    Events("onThreadWatchStopped", "onThreadWake")

    OnCreate {
      ThreadNotifications.settingsListener = { sendEvent("onThreadWatchStopped", emptyMap<String, Any>()) }
      ThreadNotifications.wakeListener = { sendEvent("onThreadWake", emptyMap<String, Any>()) }
    }

    OnDestroy {
      ThreadNotifications.settingsListener = null
      ThreadNotifications.wakeListener = null
      ThreadNotifications.scheduleWake(-1)
    }

    Function("threadConfigure") { scheme: String ->
      appContext.reactContext?.let {
        ThreadNotifications.writeStore(it, "scheme", scheme)
        ThreadNotifications.channels(it)
      }
    }

    Function("threadPost") { json: String ->
      appContext.reactContext?.let { ThreadNotifications.post(it, json) }
    }

    Function("threadCancel") { tag: String, keepFeedback: Boolean ->
      appContext.reactContext?.let { ThreadNotifications.cancel(it, tag, keepFeedback) }
    }

    Function("threadCancelAll") {
      appContext.reactContext?.let { ThreadNotifications.cancelAll(it) }
    }

    Function("threadShowResult") { tag: String, text: String, ok: Boolean ->
      appContext.reactContext?.let { ThreadNotifications.showResult(it, tag, text, ok) }
    }

    Function("threadReadStore") { key: String ->
      appContext.reactContext?.let { ThreadNotifications.readStore(it, key) }
    }

    Function("threadWriteStore") { key: String, value: String? ->
      appContext.reactContext?.let { ThreadNotifications.writeStore(it, key, value) }
    }

    Function("threadOpenTimerWindow") { timeoutMs: Double ->
      appContext.reactContext?.let { JsTimerWindow.open(it, timeoutMs.toLong()) }
    }

    Function("threadScheduleWake") { delayMs: Double ->
      ThreadNotifications.scheduleWake(delayMs.toLong())
    }

    Function("threadTimerWindowClosed") {
      JsTimerWindow.closed()
    }

    Function("threadSetWatching") { running: Boolean ->
      appContext.reactContext?.let { ThreadWatchService.setRunning(it, running) } ?: false
    }

    Function("threadIsWatching") {
      appContext.reactContext?.let { ThreadWatchService.isRunning(it) } ?: false
    }

    Function("threadPermissionState") {
      val context = appContext.reactContext
      if (context == null) {
        emptyMap<String, Any>()
      } else {
        ThreadNotifications.channels(context)
        mapOf(
          "enabled" to ThreadNotifications.notificationsEnabled(context),
          "needsYou" to ThreadNotifications.channelImportance(context, ThreadNotifications.CHANNEL_NEEDS_YOU),
          "finished" to ThreadNotifications.channelImportance(context, ThreadNotifications.CHANNEL_FINISHED),
          "errors" to ThreadNotifications.channelImportance(context, ThreadNotifications.CHANNEL_ERRORS),
        )
      }
    }

    Function("threadOpenSettings") { channel: String? ->
      val context = appContext.reactContext
      if (context == null) {
        false
      } else {
        try {
          val intent = if (channel != null && Build.VERSION.SDK_INT >= 26) {
            Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
              .putExtra(Settings.EXTRA_CHANNEL_ID, channel)
          } else if (Build.VERSION.SDK_INT >= 26) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
              .setData(android.net.Uri.parse("package:${context.packageName}"))
          }
          context.startActivity(
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }

    Function("configure") {
        deviceId: String,
        userId: String,
        scheme: String,
        ongoingEnabled: Boolean
      ->
      appContext.reactContext?.let {
        AgentNotifications.configure(it, deviceId, userId, scheme, ongoingEnabled)
      }
    }

    Function("clear") {
      appContext.reactContext?.let { AgentNotifications.clear(it) }
    }

    Function("showShowcaseActivity") { scheme: String, data: Map<String, String> ->
      appContext.reactContext?.let { AgentNotifications.showcase(it, scheme, data) }
    }

    Function("setThreadOnScreen") { path: String? ->
      AgentNotifications.setThreadOnScreen(path)
    }

    Function("openLiveUpdateSettings") {
      val context = appContext.reactContext
      if (context == null || Build.VERSION.SDK_INT < 36) {
        false
      } else {
        try {
          context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
              .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          )
          true
        } catch (_: ActivityNotFoundException) {
          false
        }
      }
    }
  }
}
