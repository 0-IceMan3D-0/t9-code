package expo.modules.t3agentnotifications

import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import expo.modules.t3appicon.AppIconStyle
import org.json.JSONArray
import org.json.JSONObject

/**
 * On-device thread notifications. JS watches the connected environments and decides what to
 * show; this object renders it, keeps one notification per thread (tag = environment + thread),
 * groups them per project, and shows action feedback without needing JS.
 */
object ThreadNotifications {
  const val TAG_PREFIX = "t3-thread:"
  private const val SUMMARY_PREFIX = "t3-thread-summary:"
  /**
   * A confirmed action shows briefly under its own tag. Android 10 keeps a card's timeoutAfter
   * alarm after the card is replaced or cancelled, so the thread's next card must not share it.
   */
  private const val RESULT_PREFIX = "t3-thread-result:"
  private const val ID = 7301
  private const val SUMMARY_ID = 7302
  private const val STORE = "t3-thread-notifications"
  private const val PAYLOAD_PREFIX = "payload:"
  const val REPLY_KEY = "t3_reply"
  const val EXTRA_PATH = "t3_path"
  private const val EXTRA_GROUP_TITLE = "t3_group_title"
  private const val EXTRA_SUMMARY_LINE = "t3_summary_line"
  private const val EXTRA_FEEDBACK = "t3_feedback"
  const val ACTION_EXPIRED = "expo.modules.t3agentnotifications.THREAD_CARD_EXPIRED"
  private const val RESULT_LIFETIME_MS = 6_000L
  private const val RELAY_COVER_MS = 15 * 60 * 1000L

  const val CHANNEL_NEEDS_YOU = "t3-needs-you"
  const val CHANNEL_FINISHED = "t3-finished"
  const val CHANNEL_ERRORS = "t3-errors"
  const val CHANNEL_WATCH = "t3-watch"
  private const val CHANNEL_GROUP = "t3-threads"

  /** Thread paths this process posted, so relay pushes for the same event stay quiet. */
  private val postedPaths = HashMap<String, Long>()
  private const val PENDING_PREFIX = "pending:"

  @Volatile var settingsListener: (() -> Unit)? = null
  @Volatile var wakeListener: (() -> Unit)? = null
  private val wakeHandler by lazy { Handler(Looper.getMainLooper()) }
  private val wake = Runnable { wakeListener?.invoke() }

  /**
   * A native delay that still fires while React Native's timers are paused, so the background
   * watcher can retry a dropped connection. A negative delay cancels it.
   */
  fun scheduleWake(delayMs: Long) {
    wakeHandler.removeCallbacks(wake)
    if (delayMs >= 0) wakeHandler.postDelayed(wake, delayMs)
  }

  private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

  private fun prefs(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  fun readStore(context: Context, key: String): String? = prefs(context).getString(key, null)

  fun writeStore(context: Context, key: String, value: String?) {
    val editor = prefs(context).edit()
    if (value == null) editor.remove(key) else editor.putString(key, value)
    editor.apply()
  }

  fun channels(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = manager(context)
    manager.createNotificationChannelGroup(NotificationChannelGroup(CHANNEL_GROUP, "Agent threads"))
    fun channel(id: String, name: String, importance: Int, description: String) =
      NotificationChannel(id, name, importance).apply {
        this.description = description
        group = CHANNEL_GROUP
      }
    manager.createNotificationChannels(
      listOf(
        channel(
          CHANNEL_NEEDS_YOU,
          "Needs you",
          NotificationManager.IMPORTANCE_HIGH,
          "An agent is waiting for an approval or an answer"
        ),
        channel(
          CHANNEL_FINISHED,
          "Finished",
          NotificationManager.IMPORTANCE_DEFAULT,
          "An agent finished its turn"
        ),
        channel(
          CHANNEL_ERRORS,
          "Errors",
          NotificationManager.IMPORTANCE_HIGH,
          "An agent's turn failed or hit a usage limit"
        ),
        channel(
          CHANNEL_WATCH,
          "Background connection",
          NotificationManager.IMPORTANCE_MIN,
          "Shown while the app stays connected for notifications"
        ),
      )
    )
  }

  fun notificationsEnabled(context: Context) =
    NotificationManagerCompat.from(context).areNotificationsEnabled()

  /** The importance Android uses for a channel now, or -1 before it exists. */
  fun channelImportance(context: Context, channel: String): Int {
    if (Build.VERSION.SDK_INT < 26) return NotificationManager.IMPORTANCE_DEFAULT
    return manager(context).getNotificationChannel(channel)?.importance ?: -1
  }

  @Synchronized
  fun post(context: Context, json: String) {
    val payload = JSONObject(json)
    val tag = payload.getString("tag")
    channels(context)
    if (!notificationsEnabled(context)) return
    if (!payload.optBoolean("alert", true)) {
      // A refresh must not bring back a dismissed card or replace action feedback.
      val active = manager(context).activeNotifications.firstOrNull { it.tag == tag && it.id == ID }
      if (active == null || active.notification.extras.getBoolean(EXTRA_FEEDBACK)) return
    }
    writeStore(context, PAYLOAD_PREFIX + tag, json)
    // A newer event replaced the card the pending action belonged to.
    writeStore(context, PENDING_PREFIX + tag, null)
    payload.optString("deepLink").takeIf { it.isNotEmpty() }?.let { path ->
      postedPaths[path] = System.currentTimeMillis()
      cancelRelayAlerts(context, path)
    }
    val card = build(context, payload, Feedback.NONE, null).build()
    manager(context).cancel(resultTag(tag), ID)
    manager(context).notify(tag, ID, card)
    updateSummary(
      context,
      payload.getString("group"),
      removedTag = resultTag(tag),
      posted = tag to card
    )
  }

  @Synchronized
  fun cancel(context: Context, tag: String, keepFeedback: Boolean) {
    val active = manager(context).activeNotifications.firstOrNull { it.tag == tag && it.id == ID }
    // A progress or result card is the answer to the user's tap; let it finish on its own.
    if (keepFeedback && active?.notification?.extras?.getBoolean(EXTRA_FEEDBACK) == true) return
    manager(context).cancel(tag, ID)
    if (!keepFeedback) manager(context).cancel(resultTag(tag), ID)
    val group = active?.notification?.group ?: readPayload(context, tag)?.optString("group")
    writeStore(context, PAYLOAD_PREFIX + tag, null)
    if (!group.isNullOrEmpty()) updateSummary(context, group, removedTag = tag)
  }

  @Synchronized
  fun cancelAll(context: Context) {
    val manager = manager(context)
    manager.activeNotifications.filter {
      it.tag?.startsWith(TAG_PREFIX) == true ||
        it.tag?.startsWith(RESULT_PREFIX) == true ||
        it.tag?.startsWith(SUMMARY_PREFIX) == true
    }.forEach { manager.cancel(it.tag, it.id) }
    val editor = prefs(context).edit()
    prefs(context).all.keys.filter { it.startsWith(PAYLOAD_PREFIX) }.forEach { editor.remove(it) }
    editor.apply()
  }

  /** Replaces the card's actions with a progress line while the action runs. */
  @Synchronized
  fun showProgress(context: Context, tag: String, text: String) {
    val payload = readPayload(context, tag) ?: return
    writeStore(context, PENDING_PREFIX + tag, "1")
    manager(context).notify(tag, ID, build(context, payload, Feedback.PROGRESS, text).build())
  }

  @Synchronized
  fun showResult(context: Context, tag: String, text: String, ok: Boolean) {
    if (readStore(context, PENDING_PREFIX + tag) == null) return
    writeStore(context, PENDING_PREFIX + tag, null)
    val payload = readPayload(context, tag) ?: return
    if (!ok) {
      manager(context).notify(tag, ID, build(context, payload, Feedback.FAILED, text).build())
      return
    }
    val card = build(context, payload, Feedback.DONE, text).build()
    manager(context).cancel(tag, ID)
    manager(context).notify(resultTag(tag), ID, card)
    writeStore(context, PAYLOAD_PREFIX + tag, null)
    updateSummary(
      context,
      payload.getString("group"),
      removedTag = tag,
      posted = resultTag(tag) to card
    )
  }

  /** Called when the action service ends: any action JS never reported is shown as unconfirmed. */
  @Synchronized
  fun failPendingActions(context: Context) {
    val pending = prefs(context).all.keys.filter { it.startsWith(PENDING_PREFIX) }
    for (tag in pending.map { it.removePrefix(PENDING_PREFIX) }) {
      showResult(context, tag, "Couldn't confirm. Open the thread to check.", false)
    }
  }

  /** True while this device shows, or recently showed, the same thread itself. */
  @Synchronized
  fun coversRelayAlert(context: Context, path: String?): Boolean {
    if (path.isNullOrEmpty()) return false
    val postedAt = postedPaths[path]
    if (postedAt != null && System.currentTimeMillis() - postedAt < RELAY_COVER_MS) return true
    return manager(context).activeNotifications.any {
      it.tag?.startsWith(TAG_PREFIX) == true && it.notification.extras.getString(EXTRA_PATH) == path
    }
  }

  private fun cancelRelayAlerts(context: Context, path: String) {
    val manager = manager(context)
    manager.activeNotifications.filter {
      it.tag == AgentNotifications.ALERT_TAG && it.notification.extras.getString(EXTRA_PATH) == path
    }.forEach { manager.cancel(it.tag, it.id) }
  }

  private fun resultTag(tag: String) = RESULT_PREFIX + tag.removePrefix(TAG_PREFIX)

  /** A timed result card expired or was dismissed: drop the summary if it was the last card. */
  @Synchronized
  fun cardRemoved(context: Context, group: String, tag: String?) {
    updateSummary(context, group, removedTag = tag)
  }

  private fun readPayload(context: Context, tag: String): JSONObject? =
    readStore(context, PAYLOAD_PREFIX + tag)?.let { runCatching { JSONObject(it) }.getOrNull() }

  private enum class Feedback { NONE, PROGRESS, DONE, FAILED }

  private fun build(
    context: Context,
    payload: JSONObject,
    feedback: Feedback,
    feedbackText: String?
  ): NotificationCompat.Builder {
    val tag = payload.getString("tag")
    val channel = payload.optString("channel", CHANNEL_FINISHED)
    val title = payload.optString("title")
    val text = if (feedback == Feedback.NONE) payload.optString("text") else feedbackText.orEmpty()
    val bigText = if (feedback == Feedback.NONE) payload.optString("bigText", text) else text
    val path = payload.optString("deepLink").takeIf { it.isNotEmpty() }
    val extras = Bundle().apply {
      putString(EXTRA_PATH, path)
      putString(EXTRA_GROUP_TITLE, payload.optString("groupTitle"))
      putString(EXTRA_SUMMARY_LINE, payload.optString("summaryLine", title))
      putBoolean(EXTRA_FEEDBACK, feedback != Feedback.NONE)
    }
    val builder = NotificationCompat.Builder(context, channel)
      .setSmallIcon(AppIconStyle.smallIcon(context)).addExtras(AppIconStyle.extras())
      .setColor(ContextCompat.getColor(context, colorFor(channel, feedback)))
      .setContentTitle(title)
      .setContentText(text)
      .setSubText(payload.optString("subText").takeIf { it.isNotEmpty() })
      .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
      .setGroup(payload.getString("group"))
      .setCategory(
        if (channel == CHANNEL_NEEDS_YOU) {
          NotificationCompat.CATEGORY_REMINDER
        } else if (channel == CHANNEL_ERRORS) {
          NotificationCompat.CATEGORY_ERROR
        } else {
          NotificationCompat.CATEGORY_STATUS
        }
      )
      .setPriority(
        if (channel == CHANNEL_FINISHED) {
          NotificationCompat.PRIORITY_DEFAULT
        } else {
          NotificationCompat.PRIORITY_HIGH
        }
      )
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion(context, channel))
      .setAutoCancel(true)
      .setContentIntent(contentIntent(context, path, tag.hashCode()))
      .addExtras(extras)
    val whenMs = payload.optLong("when", 0L)
    if (whenMs > 0) builder.setWhen(whenMs).setShowWhen(true)
    // Feedback and silent refreshes never make sound again; a new event does.
    if (feedback != Feedback.NONE || !payload.optBoolean("alert", true)) builder.setSilent(true)
    builder.setOnlyAlertOnce(!payload.optBoolean("alert", true) || feedback != Feedback.NONE)
    when (feedback) {
      Feedback.NONE -> addActions(context, builder, payload)
      Feedback.PROGRESS -> builder.setProgress(0, 0, true).setOngoing(true)
      Feedback.DONE ->
        builder.setTimeoutAfter(RESULT_LIFETIME_MS)
          .setDeleteIntent(expiredIntent(context, resultTag(tag), payload.getString("group")))
      Feedback.FAILED -> addActions(context, builder, payload)
    }
    return builder
  }

  private fun colorFor(channel: String, feedback: Feedback) = when {
    feedback == Feedback.DONE -> R.color.agent_activity_done
    feedback == Feedback.FAILED -> R.color.agent_activity_failed
    channel == CHANNEL_NEEDS_YOU -> R.color.agent_activity_attention
    channel == CHANNEL_ERRORS -> R.color.agent_activity_failed
    else -> R.color.agent_activity_done
  }

  private fun publicVersion(context: Context, channel: String) =
    NotificationCompat.Builder(context, channel)
      .setSmallIcon(AppIconStyle.smallIcon(context)).addExtras(AppIconStyle.extras())
      .setContentTitle(
        when (channel) {
          CHANNEL_NEEDS_YOU -> "An agent needs you"
          CHANNEL_ERRORS -> "An agent stopped with an error"
          else -> "An agent finished"
        }
      )
      .build()

  private fun addActions(context: Context, builder: NotificationCompat.Builder, payload: JSONObject) {
    val actions = payload.optJSONArray("actions") ?: JSONArray()
    val tag = payload.getString("tag")
    for (index in 0 until minOf(actions.length(), 3)) {
      val action = actions.getJSONObject(index)
      val intent = Intent(context, ThreadNotificationActionReceiver::class.java)
        .setAction("expo.modules.t3agentnotifications.THREAD_ACTION")
        // A unique data URI keeps each action's PendingIntent separate.
        .setData(Uri.parse("t3-thread-action://${Uri.encode(tag)}/$index"))
        .putExtra("tag", tag)
        .putExtra("environmentId", payload.optString("environmentId"))
        .putExtra("threadId", payload.optString("threadId"))
        .putExtra("action", action.optString("action"))
        .putExtra("label", action.optString("label"))
        .putExtra("progress", action.optString("progress"))
        .putExtra("decision", action.optString("decision"))
        .putExtra("requestId", action.optString("requestId"))
        .putExtra("value", action.optString("value"))
        .putExtra("mode", action.optString("mode"))
      val reply = action.optString("action") == "reply"
      // Android writes the typed reply into the intent, so a reply intent must stay mutable.
      val mutability = when {
        !reply -> PendingIntent.FLAG_IMMUTABLE
        Build.VERSION.SDK_INT >= 31 -> PendingIntent.FLAG_MUTABLE
        else -> 0
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or mutability
      val pending = PendingIntent.getBroadcast(context, (tag + index).hashCode(), intent, flags)
      val compat = NotificationCompat.Action.Builder(0, action.optString("label"), pending)
      if (reply) {
        compat.addRemoteInput(
          RemoteInput.Builder(REPLY_KEY).setLabel(action.optString("placeholder", "Reply")).build()
        ).setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
          .setShowsUserInterface(false)
          .setAllowGeneratedReplies(false)
      }
      builder.addAction(compat.build())
    }
  }

  private fun expiredIntent(context: Context, tag: String, group: String): PendingIntent {
    val intent = Intent(context, ThreadNotificationActionReceiver::class.java)
      .setAction(ACTION_EXPIRED)
      .setData(Uri.parse("t3-thread-expired:" + Uri.encode(tag)))
      .putExtra("group", group)
      .putExtra("resultTag", tag)
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    return PendingIntent.getBroadcast(context, 0, intent, flags)
  }

  private class Card(val notification: android.app.Notification, val postTime: Long)

  /**
   * One summary per project group; Android hides it while the group has a single card.
   * Notify and cancel apply asynchronously, so the caller names the card it just changed.
   */
  private fun updateSummary(
    context: Context,
    group: String,
    removedTag: String? = null,
    posted: Pair<String, android.app.Notification>? = null
  ) {
    val manager = manager(context)
    val summaryTag = SUMMARY_PREFIX + group
    val children = manager.activeNotifications.filter {
      (it.tag?.startsWith(TAG_PREFIX) == true || it.tag?.startsWith(RESULT_PREFIX) == true) &&
        it.tag != removedTag &&
        it.tag != posted?.first &&
        it.notification.group == group
    }.map { Card(it.notification, it.postTime) } +
      listOfNotNull(posted?.let { Card(it.second, System.currentTimeMillis()) })
    if (children.isEmpty()) {
      manager.cancel(summaryTag, SUMMARY_ID)
      return
    }
    val channels = children.map { it.notification.channelIdCompat() }
    val channel = when {
      CHANNEL_NEEDS_YOU in channels -> CHANNEL_NEEDS_YOU
      CHANNEL_ERRORS in channels -> CHANNEL_ERRORS
      else -> CHANNEL_FINISHED
    }
    val groupTitle = children.firstNotNullOfOrNull {
      it.notification.extras.getString(EXTRA_GROUP_TITLE)?.takeIf { title -> title.isNotEmpty() }
    } ?: "Agent threads"
    val style = NotificationCompat.InboxStyle().setBigContentTitle(groupTitle)
    children.sortedByDescending { it.postTime }.take(6).forEach {
      style.addLine(it.notification.extras.getString(EXTRA_SUMMARY_LINE))
    }
    val count = children.size
    val summary = NotificationCompat.Builder(context, channel)
      .setSmallIcon(AppIconStyle.smallIcon(context)).addExtras(AppIconStyle.extras())
      .setColor(ContextCompat.getColor(context, colorFor(channel, Feedback.NONE)))
      .setContentTitle(groupTitle)
      .setContentText(if (count == 1) "1 thread" else "$count threads")
      .setSubText(groupTitle)
      .setStyle(style)
      .setGroup(group)
      .setGroupSummary(true)
      .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion(context, channel))
      .setContentIntent(contentIntent(context, null, summaryTag.hashCode()))
      .build()
    manager.notify(summaryTag, SUMMARY_ID, summary)
  }

  private fun android.app.Notification.channelIdCompat(): String? =
    if (Build.VERSION.SDK_INT >= 26) channelId else null

  /** Opens the thread, or the app's home for null, through the activity behind the launcher alias. */
  fun contentIntent(context: Context, path: String?, requestCode: Int): PendingIntent? {
    val scheme = AgentNotifications.scheme(context)
    val threadPath = path?.takeIf {
      it.startsWith("/threads/") && !it.contains('?') && !it.contains('#')
    } ?: "/"
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    // The launcher alias is disabled when the app icon changes; target the activity behind it.
    intent.resolveActivityInfo(context.packageManager, 0)?.let {
      intent.setClassName(context.packageName, it.targetActivity ?: it.name)
    }
    intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse("$scheme:/$threadPath"))
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}
