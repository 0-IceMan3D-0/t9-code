package expo.modules.t3localserver

import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.system.Os
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet

/**
 * TCP servers listening inside the Linux environment, such as an agent's `vite` or
 * `python3 -m http.server`. Android hides /proc/net and sock_diag from apps, so the preload library
 * reports each listen() (native/usb/t3usb_preload.c), and this keeps the sockets that a guest
 * process still holds. Guests share the app's network, so 127.0.0.1 on the phone reaches them.
 *
 * Polls /proc only while it tracks a server; with none running it costs nothing.
 */
object DevServers {
  private const val POLL_MILLIS = 3_000L
  private const val ADB_PORT = 5037

  // The server itself, Claude Code and adb listen for their own use, not as something to open.
  private val INTERNAL_PROGRAMS = setOf("t3", "claude", "adb", "t3-resource-monitor")

  class Server(
    val port: Int,
    val address: String,
    val url: String,
    val pid: Int,
    val command: String,
    /** Milliseconds since boot when the socket started listening. */
    val since: Long,
  ) {
    fun toMap() = mapOf(
      "port" to port,
      "address" to address,
      "url" to url,
      "pid" to pid,
      "command" to command,
      "since" to since.toDouble(),
    )
  }

  private class Report(val port: Int, val address: String, val v6only: Boolean, val pid: Int, val since: Long)

  private val reports = ConcurrentHashMap<Long, Report>()
  private val listeners = CopyOnWriteArraySet<(List<Server>) -> Unit>()

  @Volatile
  var current: List<Server> = emptyList()
    private set

  private val handler by lazy { Handler(HandlerThread("t3-dev-servers").apply { start() }.looper) }
  private val poll = object : Runnable {
    override fun run() {
      refresh()
      if (reports.isNotEmpty()) handler.postDelayed(this, POLL_MILLIS)
    }
  }

  fun addListener(listener: (List<Server>) -> Unit) = listeners.add(listener)

  fun removeListener(listener: (List<Server>) -> Unit) = listeners.remove(listener)

  /** A line from the preload library: listen, port, address, v6only, pid, socket inode. */
  fun report(fields: List<String>) {
    val port = fields.getOrNull(1)?.toIntOrNull() ?: return
    val address = fields.getOrNull(2) ?: return
    val pid = fields.getOrNull(4)?.toIntOrNull() ?: return
    val inode = fields.getOrNull(5)?.toLongOrNull() ?: return
    if (port == LocalServerService.PORT || port == ADB_PORT || isInternal(commandLine(pid))) return
    reports[inode] = Report(port, address, fields.getOrNull(3) == "1", pid, SystemClock.elapsedRealtime())
    handler.removeCallbacks(poll)
    handler.post(poll)
  }

  /** Socket inodes held by guest processes, each with the pids that hold it. */
  private fun holders(): Map<Long, List<Int>> {
    val held = HashMap<Long, MutableList<Int>>()
    for (entry in ProcessTree.guests()) {
      val fds = File("/proc/${entry.pid}/fd").list() ?: continue
      for (fd in fds) {
        val link = try {
          Os.readlink("/proc/${entry.pid}/fd/$fd")
        } catch (_: Exception) {
          continue
        }
        if (!link.startsWith("socket:[")) continue
        val inode = link.substring(8, link.length - 1).toLongOrNull() ?: continue
        if (reports.containsKey(inode)) held.getOrPut(inode) { ArrayList() }.add(entry.pid)
      }
    }
    return held
  }

  private fun refresh() {
    val held = holders()
    reports.keys.retainAll(held.keys)
    val next = reports.entries.mapNotNull { (inode, report) ->
      val pids = held[inode] ?: return@mapNotNull null
      // A forked worker can outlive the process that called listen().
      val pid = if (report.pid in pids) report.pid else pids.min()
      Server(report.port, report.address, url(report), pid, commandLine(pid).joinToString(" "), report.since)
    }.sortedWith(compareBy({ it.port }, { it.address }))
    val key = { list: List<Server> -> list.map { listOf(it.port, it.address, it.pid, it.command) } }
    if (key(next) == key(current)) return
    current = next
    listeners.forEach { it(next) }
  }

  private fun url(report: Report): String {
    val host = when {
      report.address == "0.0.0.0" || report.address.startsWith("127.") -> "127.0.0.1"
      report.address.startsWith("::ffff:127.") -> "127.0.0.1"
      // A dual-stack socket on :: also takes IPv4.
      report.address == "::" && !report.v6only -> "127.0.0.1"
      report.address == "::" || report.address == "::1" -> "[::1]"
      report.address.contains(':') -> "[${report.address}]"
      else -> report.address
    }
    return "http://$host:${report.port}"
  }

  private fun commandLine(pid: Int): List<String> = try {
    File("/proc/$pid/cmdline").readBytes().toString(Charsets.UTF_8).split('\u0000').filter { it.isNotEmpty() }
  } catch (_: Exception) {
    emptyList()
  }


  private fun isInternal(argv: List<String>): Boolean {
    val program = argv.firstOrNull()?.substringAfterLast('/') ?: return false
    if (program in INTERNAL_PROGRAMS) return true
    // npm installs t3 and claude as scripts that node runs.
    val script = argv.getOrNull(1)?.takeIf { program == "node" || program.startsWith("node") }
    return script != null && (script.substringAfterLast('/') in INTERNAL_PROGRAMS || script.contains("@anthropic-ai/claude-code"))
  }
}
