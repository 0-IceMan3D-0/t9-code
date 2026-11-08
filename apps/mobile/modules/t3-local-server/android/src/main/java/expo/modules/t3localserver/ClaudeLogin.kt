package expo.modules.t3localserver

import java.util.concurrent.CompletableFuture
import kotlin.concurrent.thread

/**
 * Runs `claude auth login` on a pty from `script`, because it will not prompt on a plain pipe.
 * Output is scanned for the sign-in URL and a failure line and otherwise discarded.
 */
class ClaudeLogin(guest: GuestRuntime) {
  private val process = guest.process(
    listOf("script", "-qfc", "stty cols 2000; claude auth login", "/dev/null"),
  ).start()
  val url = CompletableFuture<String>()
  val finished = CompletableFuture<Int>()

  @Volatile private var failures: List<String> = emptyList()
  @Volatile private var failuresBeforeCode = 0

  /** `claude auth login` exits 0 even when the code is rejected, so failure is read from output. */
  val failure: String?
    get() = failures.drop(failuresBeforeCode).lastOrNull()

  init {
    thread(name = "t3-claude-login") {
      val text = StringBuilder()
      val buffer = CharArray(4096)
      val reader = process.inputStream.reader()
      while (true) {
        val count = reader.read(buffer)
        if (count < 0) break
        text.append(buffer, 0, count)
        val plain = text.replace(ANSI_PATTERN, "")
        if (!url.isDone) {
          URL_PATTERN.find(plain)?.let { url.complete(it.value) }
        }
        failures = FAILURE_PATTERN.findAll(plain).map { it.value.trim() }.toList()
      }
      val code = process.waitFor()
      url.completeExceptionally(IllegalStateException("Claude login exited before showing a link"))
      finished.complete(code)
    }
  }

  fun submitCode(code: String) {
    failuresBeforeCode = failures.size
    process.outputStream.apply {
      write("$code\r".toByteArray())
      flush()
    }
  }

  fun cancel() = process.destroy()

  private companion object {
    val ANSI_PATTERN = Regex("""\u001B\[[0-9;?]*[ -/]*[@-~]""")
    // The link is wrapped in an OSC 8 hyperlink, so it ends at the first control character.
    val URL_PATTERN = Regex("""https://[^\s\p{Cntrl}]+""")
    val FAILURE_PATTERN = Regex("""(?im)^.*(login failed|error)[^\r\n]*""")
  }
}
