package expo.modules.t3localserver

import java.util.concurrent.CompletableFuture
import kotlin.concurrent.thread

/**
 * Runs `claude auth login` on a pty from `script`, because it will not prompt on a plain pipe.
 * Output is scanned for the sign-in URL and otherwise discarded, so nothing sensitive is kept.
 */
class ClaudeLogin(guest: GuestRuntime) {
  private val process = guest.process(
    listOf("script", "-qfc", "stty cols 2000; claude auth login", "/dev/null"),
  ).start()
  val url = CompletableFuture<String>()
  val finished = CompletableFuture<Int>()

  init {
    thread(name = "t3-claude-login") {
      val text = StringBuilder()
      val buffer = CharArray(4096)
      val reader = process.inputStream.reader()
      while (true) {
        val count = reader.read(buffer)
        if (count < 0) break
        text.append(buffer, 0, count)
        if (!url.isDone) {
          URL_PATTERN.find(text.replace(ANSI_PATTERN, ""))?.let { url.complete(it.value) }
        }
      }
      val code = process.waitFor()
      url.completeExceptionally(IllegalStateException("Claude login exited before showing a link"))
      finished.complete(code)
    }
  }

  fun submitCode(code: String) {
    process.outputStream.apply {
      write("$code\r".toByteArray())
      flush()
    }
  }

  fun cancel() = process.destroy()

  private companion object {
    val ANSI_PATTERN = Regex("""\u001B\[[0-9;?]*[ -/]*[@-~]""")
    val URL_PATTERN = Regex("""https://\S+""")
  }
}
