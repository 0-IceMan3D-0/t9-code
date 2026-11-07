package expo.modules.t3localserver

import android.content.Context
import android.os.Environment
import java.io.File

/**
 * Starts commands inside the Linux environment. Apps targeting API 29+ cannot exec from their data
 * directory, so proot and its loader ship as native libraries and guest binaries load through them.
 */
class GuestRuntime(context: Context) {
  private val nativeDir = context.applicationInfo.nativeLibraryDir
  private val options = LocalServerOptions(context)
  val root = File(context.filesDir, "runtime")
  val rootfs = File(root, "rootfs")
  val isInstalled get() = File(root, INSTALLED_MARKER).readTextOrNull() == RUNTIME_VERSION
  private val tmp = File(root, "tmp")
  private val fakeProc = File(root, "proc")

  fun process(command: List<String>, workingDirectory: String = "/root"): ProcessBuilder {
    tmp.mkdirs()
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
