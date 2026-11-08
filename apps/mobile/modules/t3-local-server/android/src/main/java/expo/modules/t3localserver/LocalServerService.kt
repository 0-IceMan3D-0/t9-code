package expo.modules.t3localserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Foreground because OnePlus and other vendors freeze a backgrounded app's whole UID, which stops
 * every guest process with it.
 */
class LocalServerService : Service() {
  private val guest by lazy { GuestRuntime(this) }
  private val wakeLock by lazy {
    (getSystemService(POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "t3:local-server")
  }

  @Volatile
  private var stopping = false

  @Volatile
  private var server: Process? = null
  private var worker: Thread? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    goForeground("Starting")
    if (intent?.action == ACTION_STOP) {
      stopping = true
      if (worker?.isAlive == true) thread(name = "t3-local-server-stop") { stopServer() }
      else finish(LocalServerState.STOPPED)
      return START_NOT_STICKY
    }
    stopping = false
    if (worker?.isAlive != true) {
      if (!wakeLock.isHeld) wakeLock.acquire()
      worker = thread(name = "t3-local-server") { run() }
    }
    return START_STICKY
  }

  private fun run() {
    try {
      if (!guest.isInstalled) install()
      serve()
    } catch (error: Exception) {
      finish(LocalServerState.FAILED, error.message ?: error.toString())
      return
    }
    finish(LocalServerState.STOPPED)
  }

  private fun install() {
    publish(LocalServerState.INSTALLING, "Preparing")
    RuntimeInstaller(guest) { detail, progress ->
      publish(LocalServerState.INSTALLING, detail, progress)
    }.install()
  }

  private fun serve() {
    var failures = 0
    while (!stopping) {
      publish(LocalServerState.STARTING, "Starting server")
      val startedAt = System.currentTimeMillis()
      val process = guest.process(SERVER_COMMAND).start()
      server = process
      ServerLog(File(guest.root, "server.log")).use { log ->
        try {
          process.inputStream.bufferedReader().forEachLine { line ->
            PAIRING_LINE.find(line)?.let { LocalServerStatusStore.pairingUrl = it.groupValues[1] }
            log.write(line)
            if (line.contains(READY_LINE)) publish(LocalServerState.RUNNING, "Listening on port $PORT")
          }
        } catch (error: IOException) {
          if (!stopping) throw error
        }
      }
      val code = process.waitFor()
      LocalServerStatusStore.pairingUrl = null
      if (stopping) return
      failures = if (System.currentTimeMillis() - startedAt > STABLE_MILLIS) 1 else failures + 1
      if (failures >= MAX_FAILURES) throw IllegalStateException("Server keeps exiting (code $code)")
      publish(LocalServerState.STARTING, "Restarting after exit $code")
      Thread.sleep(failures * RETRY_MILLIS)
    }
  }

  // Process.destroy only sends SIGTERM to proot, which ignores it and leaves its guests running.
  private fun stopServer() {
    val process = server ?: return
    signalServer("TERM")
    if (!process.waitFor(STOP_SECONDS, TimeUnit.SECONDS)) signalServer("KILL")
  }

  // The brackets keep the pattern from matching this pkill's own proot command line.
  private fun signalServer(signal: String) {
    runCatching {
      guest.process(listOf("pkill", "-$signal", "-f", "t3 [s]erve")).start().waitFor(5, TimeUnit.SECONDS)
    }
  }

  private fun publish(state: LocalServerState, detail: String, progress: Double = 0.0) {
    LocalServerStatusStore.publish(LocalServerStatus(state, detail, progress))
    val text = if (state == LocalServerState.INSTALLING) "Setting up" else detail
    if (text != lastNotification) {
      lastNotification = text
      (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, notification(text))
    }
  }

  private var lastNotification: String? = null

  private fun finish(state: LocalServerState, detail: String = "") {
    server = null
    LocalServerStatusStore.pairingUrl = null
    LocalServerStatusStore.publish(LocalServerStatus(state, detail))
    if (wakeLock.isHeld) wakeLock.release()
    @Suppress("DEPRECATION")
    stopForeground(true)
    stopSelf()
  }

  override fun onDestroy() {
    server?.destroy()
    if (wakeLock.isHeld) wakeLock.release()
    super.onDestroy()
  }

  private fun goForeground(text: String) {
    val notification = notification(text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun notification(text: String): Notification {
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(CHANNEL_ID, "Built-in server", NotificationManager.IMPORTANCE_LOW)
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(this)
      }
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val stop = PendingIntent.getService(
      this,
      0,
      Intent(this, LocalServerService::class.java).setAction(ACTION_STOP),
      flags,
    )
    val open = openAppIntent(this)
    return builder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("Built-in server")
      .setContentText(text)
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build())
      .build()
  }

  companion object {
    const val PORT = 3783
    private const val ACTION_START = "expo.modules.t3localserver.START"
    private const val ACTION_STOP = "expo.modules.t3localserver.STOP"
    private const val CHANNEL_ID = "t3-local-server"
    private const val NOTIFICATION_ID = 3783
    private const val READY_LINE = "server is ready"
    private const val STABLE_MILLIS = 60_000L
    private const val RETRY_MILLIS = 2_000L
    private const val MAX_FAILURES = 5
    private const val STOP_SECONDS = 8L
    private val PAIRING_LINE = Regex("""^Pairing URL: (\S+)""")
    private val SERVER_COMMAND = listOf(
      "t3",
      "serve",
      "--base-dir",
      "/root/.t3",
      "--host",
      "127.0.0.1",
      "--port",
      "$PORT",
      "--no-browser",
    )

    // The launcher alias is disabled when the app icon changes; target the activity behind it.
    fun openAppIntent(context: Context): PendingIntent? {
      val packageManager = context.packageManager
      return packageManager.getLaunchIntentForPackage(context.packageName)?.let { intent ->
        intent.resolveActivityInfo(packageManager, 0)?.let {
          intent.setClassName(context.packageName, it.targetActivity ?: it.name)
        }
        PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
    }

    fun start(context: Context) = send(context, ACTION_START)

    fun stop(context: Context) = send(context, ACTION_STOP)

    private fun send(context: Context, action: String) {
      val intent = Intent(context, LocalServerService::class.java).setAction(action)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }
}
