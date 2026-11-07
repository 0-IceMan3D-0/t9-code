package expo.modules.t3localserver

import java.io.Closeable
import java.io.File
import java.io.PrintWriter

/** Keeps the last stretch of server output with pairing secrets and their QR code removed. */
class ServerLog(private val file: File) : Closeable {
  private var writer = open()

  private fun open() = PrintWriter(file.outputStream().buffered(), true)

  fun write(line: String) {
    if (SECRET_LINE.containsMatchIn(line) || QR_LINE.containsMatchIn(line)) return
    writer.println(line)
    if (file.length() > MAX_BYTES) {
      writer.close()
      file.renameTo(File(file.path + ".1"))
      writer = open()
    }
  }

  override fun close() = writer.close()

  private companion object {
    const val MAX_BYTES = 1_000_000L
    val SECRET_LINE = Regex("""^(Token|Pairing URL|App link):|token=""", RegexOption.IGNORE_CASE)
    val QR_LINE = Regex("[█▀▄]")
  }
}
