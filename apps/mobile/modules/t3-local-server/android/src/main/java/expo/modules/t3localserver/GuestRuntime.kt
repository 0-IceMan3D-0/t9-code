package expo.modules.t3localserver

import android.content.Context
import android.os.Environment
import android.util.Log
import java.io.File

/**
 * Starts commands inside the Linux environment. Apps targeting API 29+ cannot exec from their data
 * directory, so proot and its loader ship as native libraries and guest binaries load through them.
 */
class GuestRuntime(private val context: Context) {
  private val nativeDir = context.applicationInfo.nativeLibraryDir
  private val options = LocalServerOptions(context)
  val root = File(context.filesDir, "runtime")
  val rootfs = File(root, "rootfs")
  val isInstalled get() = File(root, INSTALLED_MARKER).readTextOrNull() == RUNTIME_VERSION
  private val tmp = File(root, "tmp")
  private val fakeProc = File(root, "proc")

  fun process(command: List<String>, workingDirectory: String = "/root"): ProcessBuilder {
    tmp.mkdirs()
    installUsbSupport()
    val arguments = mutableListOf(
      "$nativeDir/libproot.so",
      "--kill-on-exit",
      "--link2symlink",
      "--root-id",
      "--rootfs=${rootfs.path}",
      "--bind=/dev",
      "--bind=/proc",
      "--bind=/sys",
    )
    arguments.addAll(procBindings())
    if (options.sharedStorage) sharedProjects()?.let { arguments.add("--bind=${it.path}:$SHARED_PROJECTS_PATH") }
    arguments.addAll(
      listOf(
        "--cwd=$workingDirectory",
        "/usr/bin/env",
        "-i",
        "HOME=/root",
        "LANG=C.UTF-8",
        "TERM=xterm-256color",
        "TMPDIR=/tmp",
        "PATH=/opt/node/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        // proot's root is fake and the app sandbox holds, but Claude Code refuses to skip
        // permission prompts as root, which is what full-access threads ask for.
        "IS_SANDBOX=1",
        // t3's product events and relay traces, then Claude Code's metrics and crash reports.
        "T3CODE_TELEMETRY_ENABLED=false",
        "T3CODE_OTEL_SDK_DISABLED=true",
        "OTEL_SDK_DISABLED=true",
        "DISABLE_TELEMETRY=1",
        "DISABLE_ERROR_REPORTING=1",
        "T3USB_SOCKET=${UsbBridge.socketName(context)}",
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

  /**
   * Copies the USB bridge from the APK into the rootfs on every start, so an app update updates it.
   * adb and fastboot get wrappers that preload it; /usr/bin stays apt's.
   */
  private fun installUsbSupport() = runCatching {
    UsbBridge.start(context)
    if (!File(rootfs, "usr/local").isDirectory) return@runCatching
    syncFile(File(nativeDir, "libt3usb.so").readBytes(), File(rootfs, "usr/local/lib/t3/libt3usb.so"))
    syncFile(File(nativeDir, "libt3usb_cli.so").readBytes(), File(rootfs, "usr/local/bin/t3-usb"))
    for (tool in listOf("adb", "fastboot")) {
      syncFile(usbWrapper(tool).toByteArray(), File(rootfs, "usr/local/bin/$tool"))
    }
  }.onFailure { Log.w("T3GuestRuntime", "USB support not installed", it) }

  private fun syncFile(content: ByteArray, target: File) {
    if (target.isFile && target.length() == content.size.toLong() && target.readBytes().contentEquals(content)) return
    target.parentFile?.mkdirs()
    val temporary = File(target.parentFile, ".${target.name}.new")
    temporary.writeBytes(content)
    temporary.setExecutable(true, false)
    temporary.renameTo(target)
  }

  private fun usbWrapper(tool: String) = """
    |#!/bin/sh
    |# Added by T3² code: runs $tool with USB devices the app is allowed to use. See t3-usb.
    |real=/usr/bin/$tool
    |if [ ! -x "${'$'}real" ]; then
    |  echo "$tool is not installed. Install it with: apt install $tool" >&2
    |  exit 127
    |fi
    |LD_PRELOAD="/usr/local/lib/t3/libt3usb.so${'$'}{LD_PRELOAD:+:${'$'}LD_PRELOAD}" exec "${'$'}real" "${'$'}@"
    |""".trimMargin()

  /** Names Android's supplementary groups, or every login shell complains about them. */
  fun nameGroups() {
    val groupFile = File(rootfs, "etc/group")
    val existing = groupFile.readTextOrNull().orEmpty()
    val groups = File("/proc/self/status").readLines().first { it.startsWith("Groups:") }
      .removePrefix("Groups:").trim().split(Regex("""\s+"""))
    val missing = groups.filter { it.isNotEmpty() && !existing.contains(":x:$it:") }
    groupFile.appendText(missing.joinToString("") { "android_$it:x:$it:\n" })
  }

  /** Returns the shared folder, creating it, or null while storage access is not granted. */
  private fun sharedProjects(): File? {
    val folder = File(Environment.getExternalStorageDirectory(), "T3Projects")
    return folder.takeIf { it.isDirectory || it.mkdirs() }
  }

  // Android hides these from apps, and Node's os.cpus() and similar calls need them to parse.
  private fun procBindings(): List<String> {
    fakeProc.mkdirs()
    return FAKE_PROC.filterKeys { !File("/proc/$it").canRead() }.map { (name, content) ->
      val file = File(fakeProc, name)
      if (!file.exists()) file.writeText(content)
      "--bind=${file.path}:/proc/$name"
    }
  }

  companion object {
    const val INSTALLED_MARKER = ".installed"
    const val RUNTIME_VERSION = "1"
    const val SHARED_PROJECTS_PATH = "/root/shared-projects"

    private val FAKE_PROC = mapOf(
      "stat" to buildString {
        appendLine("cpu  1957 0 2877 93280 262 342 254 87 0 0")
        repeat(Runtime.getRuntime().availableProcessors()) {
          appendLine("cpu$it 245 0 360 11660 33 43 32 11 0 0")
        }
        appendLine("intr 0")
        appendLine("ctxt 0")
        appendLine("btime 0")
        appendLine("processes 0")
        appendLine("procs_running 1")
        appendLine("procs_blocked 0")
      },
      "loadavg" to "0.12 0.07 0.02 2/165 765\n",
      "uptime" to "124.08 932.80\n",
      "version" to "Linux version 5.4.0 (proot) #1 SMP\n",
      "vmstat" to "nr_free_pages 136778\n",
    )
  }
}

internal fun File.readTextOrNull() = takeIf { it.isFile }?.readText()?.trim()
