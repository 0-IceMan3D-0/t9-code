package expo.modules.t3localserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import expo.modules.t3appicon.AppIconStyle
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * Runs one backup or restore at a time on its own thread, behind a foreground service so it keeps
 * going when the app is in the background. Listeners hear throttled progress and the outcome.
 */
object LinuxMaintenance {
  private class Job(val operation: String) : MaintenanceProgress {
    @Volatile var cancelled = false
    @Volatile var done = 0L
    @Volatile var total = 0L
    @Volatile var detail = ""
    private var lastPublished = 0L

    override fun report(done: Long, total: Long, detail: String) {
      this.done = done
      this.total = total
      this.detail = detail
      val now = System.currentTimeMillis()
      if (now - lastPublished >= PUBLISH_MILLIS) {
        lastPublished = now
        publish(snapshot(this, "running", null))
      }
    }

    override fun checkCancelled() {
      if (cancelled) throw MaintenanceCancelled()
    }
  }

  private const val PUBLISH_MILLIS = 400L
  private val listeners = CopyOnWriteArrayList<(Map<String, Any?>) -> Unit>()

  @Volatile
  private var job: Job? = null

  @Volatile
  var last: Map<String, Any?>? = null
    private set

  val busy get() = job != null

  fun addListener(listener: (Map<String, Any?>) -> Unit) = listeners.add(listener)

  fun removeListener(listener: (Map<String, Any?>) -> Unit) = listeners.remove(listener)

  private fun snapshot(job: Job, state: String, message: String?, fileBytes: Long = 0) = mapOf(
    "operation" to job.operation,
    "state" to state,
    "done" to job.done.toDouble(),
    "total" to job.total.toDouble(),
    "detail" to job.detail,
    "message" to message,
    "fileBytes" to fileBytes.toDouble(),
  )

  private fun publish(value: Map<String, Any?>) {
    last = value
    listeners.forEach { it(value) }
  }

  fun clear() {
    if (job == null) last = null
  }

  fun cancel() {
    job?.cancelled = true
  }

  fun run(context: Context, operation: String, work: (MaintenanceProgress) -> JSONObject, onDone: (Result<JSONObject>) -> Unit) {
    val next = Job(operation)
    synchronized(this) {
      if (job != null) throw IllegalStateException("Another backup or restore is running")
      job = next
    }
    val app = context.applicationContext
    publish(snapshot(next, "running", null))
    runCatching { MaintenanceService.start(app) }
    thread(name = "t3-linux-$operation") {
      val result = runCatching { work(next) }
      val final = result.fold(
        { snapshot(next, "done", it.optString("location").ifEmpty { null }, it.optLong("fileBytes")) },
        {
          if (it is MaintenanceCancelled) snapshot(next, "cancelled", null)
          else snapshot(next, "failed", it.message ?: it.toString())
        },
      )
      synchronized(this) { job = null }
      publish(final)
      onDone(result)
    }
  }

  fun notificationText(): Pair<String, Int?>? {
    val current = job ?: return null
    val title = if (current.operation == "backup") "Backing up Linux" else "Restoring Linux"
    val percent = if (current.total > 0) (current.done * 100 / current.total).toInt().coerceIn(0, 100) else null
    return title to percent
  }
}

class MaintenanceService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val wakeLock by lazy {
    (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "t3:linux-maintenance")
  }
  private val tick = object : Runnable {
    override fun run() {
      if (refresh()) handler.postDelayed(this, 1000)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = notification("Preparing", null)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    if (!wakeLock.isHeld) wakeLock.acquire(6 * 60 * 60 * 1000L)
    handler.removeCallbacks(tick)
    handler.post(tick)
    return START_NOT_STICKY
  }

  private fun refresh(): Boolean {
    val (title, percent) = LinuxMaintenance.notificationText() ?: run {
      if (wakeLock.isHeld) wakeLock.release()
      @Suppress("DEPRECATION")
      stopForeground(true)
      stopSelf()
      return false
    }
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(title, percent))
    return true
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    if (wakeLock.isHeld) wakeLock.release()
    super.onDestroy()
  }

  private fun notification(title: String, percent: Int?): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Built-in server", NotificationManager.IMPORTANCE_LOW),
      )
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setSmallIcon(AppIconStyle.smallIcon(this))
      .setColor(AppIconStyle.accent(this))
      .setContentTitle(title)
      .setContentText(percent?.let { "$it%" } ?: "Preparing")
      .setProgress(100, percent ?: 0, percent == null)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(LocalServerService.openAppIntent(this))
      .build()
  }

  companion object {
    private const val CHANNEL_ID = "t3-local-server"
    private const val NOTIFICATION_ID = 3784

    // Stops itself on its next tick once the job is over.
    fun start(context: Context) {
      val intent = Intent(context, MaintenanceService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }
  }
}
