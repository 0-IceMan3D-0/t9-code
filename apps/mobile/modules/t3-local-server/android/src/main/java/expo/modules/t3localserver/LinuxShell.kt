package expo.modules.t3localserver

import java.io.File
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * An interactive root shell in the guest, independent of the server. `script` owns the pty, so
 * resizing goes through `stty -F` on the pty it reports, which also delivers SIGWINCH.
 */
class LinuxShell(
  private val guest: GuestRuntime,
  cols: Int,
  rows: Int,
  private val onOutput: (String) -> Unit,
  private val onExit: () -> Unit,
) {
  private val ttyFile = File(guest.rootfs, "tmp/.t3-shell-tty").apply { delete() }
  private val process = guest.apply { nameGroups() }.process(
    listOf("script", "-qfc", "stty rows $rows cols $cols; tty > /tmp/.t3-shell-tty; exec bash -l", "/dev/null"),
  ).start()
  private val input = process.outputStream
  private val history = StringBuilder()
  private val pendingSize = AtomicReference<Pair<Int, Int>?>(null)

  @Volatile
  private var resizing = false

  init {
    thread(name = "t3-linux-shell") {
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
    thread(name = "t3-linux-shell-resize") {
      while (true) {
        val (nextCols, nextRows) = pendingSize.getAndSet(null) ?: break
        val tty = ttyFile.readTextOrNull() ?: continue
        guest.process(listOf("stty", "-F", tty, "rows", "$nextRows", "cols", "$nextCols")).start().waitFor()
      }
      resizing = false
    }
  }

  fun close() = process.destroy()

  private companion object {
    const val MAX_HISTORY = 200_000
  }
}
