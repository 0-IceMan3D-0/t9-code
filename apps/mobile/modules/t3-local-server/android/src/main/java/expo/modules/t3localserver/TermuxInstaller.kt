package expo.modules.t3localserver

import android.system.Os
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

private val BOOTSTRAP = PinnedDownload(
  "https://github.com/termux/termux-packages/releases/download/" +
    "bootstrap-2026.11.01-r1%2Bapt.android-7/bootstrap-aarch64.zip",
  "5a1429b6c68ee3bdc17b5fd6e47ba42933ec924cd7283fe74992574e1d5badae",
  "bootstrap-aarch64.zip",
)
private val EXECUTABLE_PATHS = listOf("bin/", "libexec/", "lib/apt/apt-helper", "lib/apt/methods/")
private const val SYMLINKS_FILE = "SYMLINKS.txt"
private const val SYMLINK_SEPARATOR = "←"
private const val ENTRY_COUNT = 3775.0

/** Unpacks the way the Termux app's own installer does. The first login runs its second stage. */
class TermuxInstaller(
  private val termux: TermuxRuntime,
  private val report: (detail: String, progress: Double) -> Unit,
) {
  fun install() {
    val downloads = File(termux.base, "downloads").apply { mkdirs() }
    File(termux.base, TermuxRuntime.INSTALLED_MARKER).delete()
    val bootstrap = downloadPinned(BOOTSTRAP, downloads, "Downloading Termux", 0.0, 0.7, report)

    RuntimeInstaller.removeTree(termux.root)
    termux.prefix.mkdirs()
    termux.home.mkdirs()
    // Real Termux gets this from its app cache directory, and apt fails without it.
    termux.guestFile("data/data/com.termux/cache/apt/archives/partial").mkdirs()
    TermuxRuntime.HOST_PATHS.forEach { termux.guestFile(it).mkdirs() }

    unpack(bootstrap)
    bootstrap.delete()
    File(termux.base, TermuxRuntime.INSTALLED_MARKER).writeText(BOOTSTRAP.sha256)
  }

  private fun unpack(bootstrap: File) {
    var entries = 0
    var symlinks = emptyList<String>()
    ZipInputStream(bootstrap.inputStream().buffered()).use { zip ->
      while (true) {
        val entry = zip.nextEntry ?: break
        entries += 1
        if (entries % 100 == 0) report("Unpacking Termux", 0.7 + 0.3 * (entries / ENTRY_COUNT).coerceAtMost(1.0))
        val target = File(termux.prefix, entry.name)
        when {
          entry.isDirectory -> target.mkdirs()
          entry.name == SYMLINKS_FILE -> symlinks = String(zip.readBytes()).lines()
          else -> {
            target.parentFile?.mkdirs()
            FileOutputStream(target).use { zip.copyTo(it) }
            if (EXECUTABLE_PATHS.any { entry.name.startsWith(it) }) Os.chmod(target.path, 0b111_000_000)
          }
        }
      }
    }
    symlinks.forEach(::link)
  }

  private fun link(line: String) {
    if (line.isBlank()) return
    val (target, path) = line.split(SYMLINK_SEPARATOR, limit = 2)
    val file = File(termux.prefix, path)
    file.parentFile?.mkdirs()
    Os.symlink(target, file.path)
  }
}
