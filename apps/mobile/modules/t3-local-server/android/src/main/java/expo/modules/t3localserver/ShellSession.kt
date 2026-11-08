package expo.modules.t3localserver

import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * An interactive shell whose pty is owned by `script`. Resizing goes through `stty -F` on the pty
 * it reports, which also delivers SIGWINCH.
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

  /** The last window title the shell or a program set, such as bash's "root@localhost: ~/app". */
  @Volatile
  var title: String? = null
    private set
  private var titleCarry = ""

  init {
    thread(name = "t3-shell") {
      val reader = process.inputStream.reader()
      val buffer = CharArray(8192)
      while (true) {
        val count = runCatching { reader.read(buffer) }.getOrDefault(-1)
        if (count < 0) break
        val text = String(buffer, 0, count)
        scanTitle(text)
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

  /** Android's destroyForcibly sends only SIGTERM, which proot ignores. */
  fun close() {
    ProcessTree.killProcess(process)
    process.waitFor(5, TimeUnit.SECONDS)
  }

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

  // The first resize arrives while proot is still starting, before the shell has reported its pty.
  private fun ttyWhenReady(): String? {
    repeat(TTY_WAIT_ATTEMPTS) {
      info()?.getOrNull(1)?.let { return it }
      if (!process.isAlive) return null
      Thread.sleep(TTY_WAIT_MILLIS)
    }
    return null
  }

  // proot tracks each guest's folder itself, so /proc/<pid>/cwd is useless; titles are what is left.
  private fun scanTitle(text: String) {
    val combined = titleCarry + text
    TITLE.findAll(combined).lastOrNull()?.let { title = it.groupValues[1] }
    val open = combined.lastIndexOf("\u001b]")
    titleCarry = if (open >= 0 && TITLE.find(combined, open) == null && combined.length - open < MAX_TITLE_CARRY) {
      combined.substring(open)
    } else {
      ""
    }
  }

  /** The shell's pid, once `script` has started it. proot does not hide real pids. */
  fun shellPid() = info()?.getOrNull(0)?.toIntOrNull()

  private fun info() = infoFile.readTextOrNull()?.trim()?.split(" ")?.takeIf { it.size == 2 }

  companion object {
    private const val MAX_HISTORY = 200_000
    private const val MAX_TITLE_CARRY = 512
    private val TITLE = Regex("\u001b\\][012];([^\u0007\u001b]*)(?:\u0007|\u001b\\\\)")
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
