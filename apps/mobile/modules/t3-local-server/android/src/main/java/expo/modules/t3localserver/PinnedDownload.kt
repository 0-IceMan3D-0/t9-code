package expo.modules.t3localserver

import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

data class PinnedDownload(val url: String, val sha256: String, val fileName: String)

fun downloadPinned(
  item: PinnedDownload,
  directory: File,
  label: String,
  from: Double,
  to: Double,
  report: (detail: String, progress: Double) -> Unit,
): File {
  val file = File(directory, item.fileName)
  if (file.isFile && sha256(file) == item.sha256) return file
  val connection = URL(item.url).openConnection() as HttpURLConnection
  val existing = file.takeIf { it.isFile }?.length() ?: 0L
  if (existing > 0) connection.setRequestProperty("Range", "bytes=$existing-")
  connection.connectTimeout = 30_000
  connection.readTimeout = 60_000
  connection.connect()
  val resuming = connection.responseCode == HttpURLConnection.HTTP_PARTIAL
  if (!resuming && connection.responseCode != HttpURLConnection.HTTP_OK) {
    throw IOException("${item.url} returned ${connection.responseCode}")
  }
  val total = connection.contentLengthLong + if (resuming) existing else 0L
  var written = if (resuming) existing else 0L
  connection.inputStream.use { input ->
    FileOutputStream(file, resuming).use { output ->
      val buffer = ByteArray(1 shl 16)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        output.write(buffer, 0, count)
        written += count
        if (total > 0) {
          report("$label ${written * 100 / total}%", from + (to - from) * written / total)
        }
      }
    }
  }
  if (sha256(file) != item.sha256) {
    file.delete()
    throw IOException("Checksum mismatch for ${item.fileName}")
  }
  return file
}

private fun sha256(file: File): String {
  val digest = MessageDigest.getInstance("SHA-256")
  FileInputStream(file).use { input ->
    val buffer = ByteArray(1 shl 16)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      digest.update(buffer, 0, count)
    }
  }
  return digest.digest().joinToString("") { "%02x".format(it) }
}
