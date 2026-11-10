package expo.modules.t3appupdate

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

private const val PROGRESS_EVENT = "onProgress"
private const val PREFS = "t3_app_update"

/** Downloads a release APK and hands it to Android's installer, which asks the user to confirm. */
class T3AppUpdateModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready", null)

  override fun definition() = ModuleDefinition {
    Name("T3AppUpdate")
    Events(PROGRESS_EVENT)

    Function("versionCode") { installedPackage(context).longVersion() }

    // Android 8+ asks once per app before it may install other APKs.
    Function("canInstall") {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
    }

    Function("openInstallSettings") {
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    Function("getNumber") { key: String -> prefs(context).getLong(key, 0L).toDouble() }
    Function("setNumber") { key: String, value: Double -> prefs(context).edit().putLong(key, value.toLong()).apply() }

    AsyncFunction("downloadAndInstall") { url: String ->
      val ctx = context
      val file = File(ctx.cacheDir, "updates/update.apk").apply { parentFile?.mkdirs(); delete() }
      download(url, file)
      // Android would refuse an APK for another app or an older build anyway; this says why.
      val archive = ctx.packageManager.getPackageArchiveInfo(file.path, 0)
        ?: throw CodedException("ERR_BAD_APK", "The download is not a valid app.", null)
      if (archive.packageName != ctx.packageName) {
        throw CodedException("ERR_BAD_APK", "The download is for another app (${archive.packageName}).", null)
      }
      if (archive.longVersion() <= installedPackage(ctx).longVersion()) {
        throw CodedException("ERR_NOT_NEWER", "The download is not newer than this version.", null)
      }
      val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.SharingFileProvider", file)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
    }
  }

  private fun download(url: String, file: File) {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = 30_000
    connection.readTimeout = 60_000
    try {
      if (connection.responseCode !in 200..299) {
        throw CodedException("ERR_DOWNLOAD", "Download failed: HTTP ${connection.responseCode}", null)
      }
      val total = connection.contentLengthLong
      var done = 0L
      var lastSent = -1
      connection.inputStream.use { input ->
        file.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            done += read
            val percent = if (total > 0) (done * 100 / total).toInt() else -1
            if (percent != lastSent) {
              lastSent = percent
              sendEvent(PROGRESS_EVENT, mapOf("progress" to if (total > 0) done.toDouble() / total else 0.0))
            }
          }
        }
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun installedPackage(ctx: Context) = ctx.packageManager.getPackageInfo(ctx.packageName, 0)

  @Suppress("DEPRECATION")
  private fun PackageInfo.longVersion(): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) longVersionCode else versionCode.toLong()
}
