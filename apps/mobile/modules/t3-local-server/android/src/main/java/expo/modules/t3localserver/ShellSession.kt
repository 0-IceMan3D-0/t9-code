package expo.modules.t3localserver

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * An interactive shell whose pty is owned by `script`. Resizing goes through `stty -F` on the pty
 * it reports, which also delivers SIGWINCH. proot does not hide pids, so the reported one can be
 * signalled directly. Process.destroy cannot end a session because proot ignores SIGTERM.
 */
class ShellSession(
  command: ProcessBuilder,
  private val infoFile: File,
  private val resizeCommand: (tty: String, cols: Int, rows: Int) -> ProcessBuilder,
  private val onOutput: (String) -> Unit,
  private val onExit: () -> Unit,
) {
  private val process = command.also { infoFile.delete() }.start()
  private val input = process.outputStream
  private val history = StringBuilder()
  private val pendingSize = AtomicReference<Pair<Int, Int>?>(null)

  @Volatile
  private var resizing = false

  init {
    thread(name = "t3-shell") {
      val reader = process.inputStream.reader()
      val buffer = CharArray(8192)
      while (true) {
        val count = runCatching { reader.read(buffer) }.getOrDefault(-1)
        if (count < 0) break
        val text = String(buffer, 0, count)
        synchronized(history) {
          history.append(text)
          if (history.length > MAX_HISTORY) history.delete(0, history.length - MAX_HISTORY)
        }
        onOutput(text)
      }
      process.waitFor()
      infoFile.delete()
      onExit()
    }
  }

  val isAlive get() = process.isAlive

  fun history() = synchronized(history) { history.toString() }

  fun write(data: String) {
    input.write(data.toByteArray())
    input.flush()
  }

  fun resize(cols: Int, rows: Int) {
    pendingSize.set(cols to rows)
    if (resizing) return
    resizing = true
    thread(name = "t3-shell-resize") {
      while (true) {
        val tty = ttyWhenReady() ?: break
        val (nextCols, nextRows) = pendingSize.getAndSet(null) ?: break
        resizeCommand(tty, nextCols, nextRows).start().waitFor()
      }
      resizing = false
    }
  }

  fun close() {
    val pid = info()?.firstOrNull()?.toIntOrNull() ?: return
    val proot = tracerOf(pid)
    thread(name = "t3-shell-close") {
      runCatching { Os.kill(pid, OsConstants.SIGHUP) }
      if (process.waitFor(CLOSE_SECONDS, TimeUnit.SECONDS)) return@thread
      // A stopped tracee can keep proot alive after the shell is gone.
      listOfNotNull(pid, proot).forEach { runCatching { Os.kill(it, OsConstants.SIGKILL) } }
    }
  }

  private fun tracerOf(pid: Int) = File("/proc/$pid/status").readTextOrNull()?.let {
    TRACER_LINE.find(it)?.groupValues?.get(1)?.toIntOrNull()?.takeIf { tracer -> tracer > 0 }
  }

  // The first resize arrives while proot is still starting, before the shell has reported its pty.
  private fun ttyWhenReady(): String? {
    repeat(TTY_WAIT_ATTEMPTS) {
      info()?.getOrNull(1)?.let { return it }
      if (!process.isAlive) return null
      Thread.sleep(TTY_WAIT_MILLIS)
    }
    return null
  }

  private fun info() = infoFile.readTextOrNull()?.trim()?.split(" ")?.takeIf { it.size == 2 }

  companion object {
    private const val MAX_HISTORY = 200_000
    private val TRACER_LINE = Regex("""TracerPid:\s+(\d+)""")
    private const val CLOSE_SECONDS = 3L
    private const val TTY_WAIT_ATTEMPTS = 100
    private const val TTY_WAIT_MILLIS = 100L

    fun scriptCommand(cols: Int, rows: Int, infoPath: String, shell: String) = listOf(
      "script",
      "-qfc",
      "stty rows $rows cols $cols; echo \"\$\$ \$(tty)\" > $infoPath; exec $shell",
      "/dev/null",
    )
  }
}
