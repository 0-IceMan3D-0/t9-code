package expo.modules.t3localserver

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.StatFs
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import expo.modules.t3appicon.AppIconStyle
import java.io.File

/** Samples the built-in environment from the app side; /proc/stat is blocked, so per process. */
object ServerHealth {
  private const val PAGE_FALLBACK = 4096L
  private const val LOW_AVAILABLE_SHARE = 0.10
  private const val LARGE_TREE_SHARE = 0.40
  private const val NOTIFY_INTERVAL_MILLIS = 30 * 60 * 1000L
  private const val CHANNEL_ID = "t3-server-warnings"
  private const val NOTIFICATION_ID = 3785

  class Tree(val rssBytes: Long, val cpuTicks: Long, val processes: Int)

  fun tree(): Tree {
    val guests = ProcessTree.guests()
    val page = runCatching { Os.sysconf(OsConstants._SC_PAGESIZE) }.getOrDefault(PAGE_FALLBACK)
    return Tree(guests.sumOf { it.rssPages } * page, guests.sumOf { it.cpuTicks }, guests.size)
  }

  private fun memory(context: Context) = ActivityManager.MemoryInfo().also {
    (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(it)
  }

  fun warning(tree: Tree, memory: ActivityManager.MemoryInfo): String? = when {
    memory.lowMemory || memory.availMem < memory.totalMem * LOW_AVAILABLE_SHARE -> "deviceLow"
    tree.rssBytes > memory.totalMem * LARGE_TREE_SHARE -> "treeLarge"
    else -> null
  }

  fun sample(context: Context): Map<String, Any?> {
    val tree = tree()
    val memory = memory(context)
    return mapOf(
      "at" to SystemClock.elapsedRealtime().toDouble(),
      "rssBytes" to tree.rssBytes.toDouble(),
      "cpuTicks" to tree.cpuTicks.toDouble(),
      "ticksPerSecond" to runCatching { Os.sysconf(OsConstants._SC_CLK_TCK) }.getOrDefault(100L).toDouble(),
      "cores" to Runtime.getRuntime().availableProcessors(),
      "processes" to tree.processes,
      "totalMemory" to memory.totalMem.toDouble(),
      "availableMemory" to memory.availMem.toDouble(),
      "warning" to warning(tree, memory),
    )
  }

  /** Space taken on disk (allocated blocks), with private projects counted on their own. */
  fun storage(context: Context): Map<String, Any?> {
    val guest = GuestRuntime(context)
    val projects = File(guest.rootfs, "root/projects").path
    var linux = 0L
    var projectBytes = 0L
    fun visit(file: File) {
      val stat = try {
        Os.lstat(file.path)
      } catch (_: ErrnoException) {
        return
      }
      val bytes = stat.st_blocks * 512
      if (file.path == projects || file.path.startsWith("$projects/")) projectBytes += bytes else linux += bytes
      if (OsConstants.S_ISDIR(stat.st_mode)) file.listFiles()?.forEach(::visit)
    }
    if (guest.root.isDirectory) visit(guest.root)
    val disk = StatFs(context.filesDir.path)
    return mapOf(
      "linuxBytes" to linux.toDouble(),
      "projectBytes" to projectBytes.toDouble(),
      "freeBytes" to disk.availableBytes.toDouble(),
      "totalBytes" to disk.totalBytes.toDouble(),
    )
  }

  private var lastNotified = 0L

  /** Called by the server's service; warns only while no screen of the app is in front. */
  fun checkInBackground(context: Context) {
    val memory = memory(context)
    val tree = tree()
    val warning = warning(tree, memory) ?: return
    val state = ActivityManager.RunningAppProcessInfo().also { ActivityManager.getMyMemoryState(it) }
    if (state.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) return
    val now = SystemClock.elapsedRealtime()
    if (lastNotified != 0L && now - lastNotified < NOTIFY_INTERVAL_MILLIS) return
    lastNotified = now
    notify(context, warning, tree, memory)
  }

  private fun megabytes(bytes: Long) = "${bytes / (1L shl 20)} MB"

  private fun notify(context: Context, warning: String, tree: Tree, memory: ActivityManager.MemoryInfo) {
    val manager = context.getSystemService(NotificationManager::class.java)
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Built-in server warnings", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "Low memory that may stop the built-in server and its agents"
        },
      )
      Notification.Builder(context, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context)
    }
    val title = if (warning == "deviceLow") "Phone memory is low" else "Linux is using a lot of memory"
    val text = "Android may stop the built-in server and its agents. Linux uses ${megabytes(tree.rssBytes)}, " +
      "${megabytes(memory.availMem)} of the phone's memory is free. Close other apps or stop agents you don't need."
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) builder.setTimeoutAfter(NOTIFY_INTERVAL_MILLIS)
    manager.notify(
      NOTIFICATION_ID,
      builder
        .setSmallIcon(AppIconStyle.smallIcon(context)).addExtras(AppIconStyle.extras())
        .setColor(AppIconStyle.accent(context))
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(Notification.BigTextStyle().bigText(text))
        .setContentIntent(LocalServerService.openAppIntent(context))
        .setAutoCancel(true)
        .build(),
    )
  }
}
