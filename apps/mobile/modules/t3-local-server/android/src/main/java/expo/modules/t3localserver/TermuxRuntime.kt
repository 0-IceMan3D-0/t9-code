package expo.modules.t3localserver

import android.content.Context
import java.io.File

/**
 * The unmodified Termux bootstrap under proot. Its binaries hardcode com.termux paths, so they sit
 * at those paths inside a private root. The real /data/data/com.termux belongs to the installed
 * Termux app and cannot even be listed from here, which rules out proot's `-r /`.
 */
class TermuxRuntime(context: Context) {
  private val nativeDir = context.applicationInfo.nativeLibraryDir
  val base = File(context.filesDir, "termux")
  val root = File(base, "root")
  val prefix = File(root, "$DATA/usr")
  val home = File(root, "$DATA/home")
  val isInstalled get() = File(base, INSTALLED_MARKER).isFile

  fun guestFile(guestPath: String) = File(root, guestPath)

  fun process(command: List<String>): ProcessBuilder {
    val tmp = File(base, "tmp").apply { mkdirs() }
    val arguments = mutableListOf(
      "$nativeDir/libproot.so",
      "--kill-on-exit",
      "--link2symlink",
      "--rootfs=${root.path}",
    )
    arguments.addAll(HOST_PATHS.filter { File(it).exists() }.map { "--bind=$it" })
    arguments.addAll(
      listOf(
        "--cwd=$HOME",
        "/system/bin/env",
        "-i",
        "HOME=$HOME",
        "PREFIX=$PREFIX",
        "TMPDIR=$PREFIX/tmp",
        "PATH=$PREFIX/bin",
        "SHELL=$PREFIX/bin/bash",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "ANDROID_ROOT=/system",
        "ANDROID_DATA=/data",
        "TERMUX_VERSION=$TERMUX_VERSION",
        "TERMUX_APP_PACKAGE_MANAGER=apt",
      ),
    )
    arguments.addAll(command)
    return ProcessBuilder(arguments).redirectErrorStream(true).apply {
      environment().putAll(
        mapOf(
          "LD_LIBRARY_PATH" to nativeDir,
          "PROOT_LOADER" to "$nativeDir/libproot_loader.so",
          "PROOT_TMP_DIR" to tmp.path,
        ),
      )
    }
  }

  companion object {
    const val INSTALLED_MARKER = ".installed"
    const val PREFIX = "/data/data/com.termux/files/usr"
    val HOST_PATHS = listOf(
      "/system", "/apex", "/vendor", "/odm", "/product", "/system_ext", "/linkerconfig",
      "/dev", "/proc", "/sys", "/sdcard", "/storage",
    )
    private const val DATA = "data/data/com.termux/files"
    private const val HOME = "/data/data/com.termux/files/home"
    private const val TERMUX_VERSION = "0.118.3"
  }
}
