package expo.modules.t3localserver

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.annotation.RequiresApi
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

private const val FOLDER = "T3² code"
private const val PROGRESS_STEP_BYTES = 1L shl 20
private const val MAX_NAME_ATTEMPTS = 50

/** MediaStore needs no storage permission for an app's own Downloads, and it uniquifies the name. */
@RequiresApi(Build.VERSION_CODES.Q)
object PublicDownloads {
  fun save(
    context: Context,
    url: String,
    fileName: String,
    onProgress: (written: Long, total: Long) -> Unit,
  ): String {
    val resolver = context.contentResolver
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = 30_000
    connection.readTimeout = 60_000
    connection.setRequestProperty("Accept-Encoding", "identity")
    try {
      if (connection.responseCode != HttpURLConnection.HTTP_OK) {
        throw IOException("The server answered ${connection.responseCode}.")
      }
      val total = connection.contentLengthLong
      val item = insert(context, fileName)
      try {
        val written = copy(connection, resolver.openOutputStream(item), total, onProgress)
        if (total >= 0 && written != total) throw IOException("The connection ended early.")
        resolver.update(item, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        return displayName(context, item) ?: fileName
      } catch (error: Exception) {
        resolver.delete(item, null, null)
        throw error
      }
    } finally {
      connection.disconnect()
    }
  }

  // MediaStore uniquifies against files on disk, so a row left by a file deleted behind its back
  // makes the insert fail for that name.
  private fun insert(context: Context, fileName: String): Uri {
    repeat(MAX_NAME_ATTEMPTS) { attempt ->
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, numberedName(fileName, attempt))
        put(MediaStore.Downloads.MIME_TYPE, mimeType(fileName))
        put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      runCatching { context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) }
        .getOrNull()
        ?.let { return it }
    }
    throw IOException("Android could not create the file in Downloads.")
  }

  private fun numberedName(fileName: String, number: Int): String {
    if (number == 0) return fileName
    val dot = fileName.lastIndexOf('.').takeIf { it > 0 } ?: fileName.length
    return "${fileName.substring(0, dot)} ($number)${fileName.substring(dot)}"
  }

  private fun copy(
    connection: HttpURLConnection,
    target: OutputStream?,
    total: Long,
    onProgress: (written: Long, total: Long) -> Unit,
  ): Long {
    val output = target ?: throw IOException("Android could not open the file in Downloads.")
    var written = 0L
    var reported = 0L
    output.use {
      connection.inputStream.use { input ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
          val count = try {
            input.read(buffer)
          } catch (error: IOException) {
            throw IOException("The connection ended early.", error)
          }
          if (count < 0) break
          output.write(buffer, 0, count)
          written += count
          if (written - reported >= PROGRESS_STEP_BYTES) {
            reported = written
            onProgress(written, total)
          }
        }
      }
    }
    return written
  }

  private fun mimeType(fileName: String) =
    MimeTypeMap.getSingleton().getMimeTypeFromExtension(fileName.substringAfterLast('.', "").lowercase())
      ?: "application/octet-stream"

  private fun displayName(context: Context, item: Uri) =
    context.contentResolver.query(item, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    }
}
