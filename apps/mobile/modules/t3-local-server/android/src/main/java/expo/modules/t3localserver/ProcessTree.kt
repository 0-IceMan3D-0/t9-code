package expo.modules.t3localserver

import android.os.Process
import android.system.Os
import android.system.OsConstants
import java.io.File

/**
 * The app's own processes, read from /proc. Android mounts /proc with hidepid, so the app sees only
 * its UID: itself, proot and the guests under it. Their stat and cmdline are readable on API 29+.
 */
object ProcessTree {
  class Entry(val pid: Int, val ppid: Int, val tracer: Int, val cpuTicks: Long, val rssPages: Long)

  private fun read(pid: Int): Entry? = try {
    val text = File("/proc/$pid/stat").readText()
    // The command name sits in parentheses and may itself hold spaces or parentheses.
    val fields = text.substring(text.lastIndexOf(')') + 2).split(' ')
    // Guests that daemonize leave proot's tree of parents, but proot keeps tracing them.
    val tracer = File("/proc/$pid/status").useLines { lines ->
      lines.firstOrNull { it.startsWith("TracerPid:") }?.substringAfter(':')?.trim()?.toIntOrNull() ?: 0
    }
    Entry(pid, fields[1].toInt(), tracer, fields[11].toLong() + fields[12].toLong(), fields[21].toLong())
  } catch (_: Exception) {
    null
  }

  private fun isProot(pid: Int) = try {
    val argv0 = File("/proc/$pid/cmdline").readBytes().takeWhile { it != 0.toByte() }.toByteArray()
    String(argv0).endsWith("/libproot.so")
  } catch (_: Exception) {
    false
  }

  private fun all() = File("/proc").list().orEmpty().mapNotNull { it.toIntOrNull() }
    .filter { it != Process.myPid() }
    .mapNotNull(::read)

  /** The given proots and every process they trace or started, roots first. */
  private fun below(entries: List<Entry>, roots: List<Entry>): List<Entry> {
    val children = HashMap<Int, MutableList<Entry>>()
    for (entry in entries) {
      children.getOrPut(entry.ppid) { ArrayList() }.add(entry)
      if (entry.tracer != 0 && entry.tracer != entry.ppid) children.getOrPut(entry.tracer) { ArrayList() }.add(entry)
    }
    val result = ArrayList<Entry>()
    val pending = ArrayDeque(roots)
    val seen = HashSet<Int>()
    while (pending.isNotEmpty()) {
      val next = pending.removeFirst()
      if (!seen.add(next.pid)) continue
      result.add(next)
      children[next.pid]?.let(pending::addAll)
    }
    return result
  }

  fun commandLine(pid: Int): List<String> = try {
    File("/proc/$pid/cmdline").readBytes().toString(Charsets.UTF_8).split('\u0000').filter { it.isNotEmpty() }
  } catch (_: Exception) {
    emptyList()
  }

  /** Processes started under [pid], children first. */
  fun descendants(pid: Int): List<Entry> {
    val entries = all()
    val root = entries.firstOrNull { it.pid == pid } ?: return emptyList()
    return below(entries, listOf(root)).drop(1)
  }

  /** Every proot the app started and everything running under them. */
  fun guests(): List<Entry> {
    val entries = all()
    return below(entries, entries.filter { isProot(it.pid) })
  }

  // Android's process class prints itself as "Process[pid=1234, ...]" and has no pid() before API 33.
  private val PID = Regex("""pid=(\d+)""")

  fun pidOf(process: java.lang.Process): Int? =
    PID.find(process.toString())?.groupValues?.get(1)?.toIntOrNull()
      ?: runCatching { process.javaClass.getDeclaredField("pid").apply { isAccessible = true }.getInt(process) }.getOrNull()

  /** Kills a process this app started through proot, with everything under it. */
  fun killProcess(process: java.lang.Process) {
    val pid = pidOf(process)
    if (pid != null) kill(pid) else process.destroyForcibly()
  }

  /**
   * SIGKILLs a proot and all its guests, guests first. proot ignores SIGTERM, and once it dies its
   * guests would keep running untraced, outside the rootfs.
   */
  fun kill(rootPid: Int) {
    val entries = all()
    val root = entries.firstOrNull { it.pid == rootPid } ?: return
    below(entries, listOf(root)).asReversed().forEach { runCatching { Os.kill(it.pid, OsConstants.SIGKILL) } }
  }
}
