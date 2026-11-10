package expo.modules.t3localserver

import android.system.Os
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.zip.GZIPInputStream

private val ROOTFS = PinnedDownload(
  "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-arm64.tar.gz",
  "a91d5a93010193712d346d761372b7c9db6dfcf093893161c64ca107f05914f2",
  "rootfs.tar.gz",
)
private val NODE = PinnedDownload(
  "https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-arm64.tar.gz",
  "95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2",
  "node.tar.gz",
)
private const val T3_VERSION = "0.1.7"

private val GUEST_SETUP = """
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps \
    python3 ripgrep unzip xz-utils less nano
  npm install -g t3@$T3_VERSION
  mkdir -p /root/projects
""".trimIndent()

/** Every step can rerun after a crash: finished work is detected or redone, never half trusted. */
class RuntimeInstaller(
  private val guest: GuestRuntime,
  private val report: (detail: String, progress: Double) -> Unit,
) {
  private val downloads = File(guest.root, "downloads")

  fun install() {
    downloads.mkdirs()
    File(guest.root, GuestRuntime.INSTALLED_MARKER).delete()
    val rootfs = downloadPinned(ROOTFS, downloads, "Downloading Linux", 0.0, 0.1, report)
    val node = downloadPinned(NODE, downloads, "Downloading Node", 0.1, 0.2, report)

    report("Unpacking Linux", 0.2)
    removeTree(guest.rootfs)
    guest.rootfs.mkdirs()
    extract(rootfs, guest.rootfs, stripComponents = 0)
    report("Unpacking Node", 0.3)
    val nodeRoot = File(guest.rootfs, "opt/node").apply { mkdirs() }
    extract(node, nodeRoot, stripComponents = 1)

    configure()
    report("Installing tools", 0.35)
    val process = guest.process(listOf("/bin/sh", "-c", GUEST_SETUP)).start()
    val log = File(guest.root, "install.log")
    var lines = 0
    log.printWriter().use { writer ->
      process.inputStream.bufferedReader().forEachLine { line ->
        writer.println(line)
        writer.flush()
        lines += 1
        report(line.take(80), (0.35 + lines / 1500.0).coerceAtMost(0.95))
      }
    }
    val code = process.waitFor()
    if (code != 0) throw IOException("Setup failed with exit code $code. See the install log.")
    downloads.listFiles()?.forEach { it.delete() }
    report("Restoring kept files", 0.97)
    KeptFiles.restore(guest)
    File(guest.root, GuestRuntime.INSTALLED_MARKER).writeText(GuestRuntime.RUNTIME_VERSION)
  }

  private fun configure() {
    val etc = File(guest.rootfs, "etc")
    File(etc, "resolv.conf").apply { delete() }.writeText("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
    File(etc, "hosts").writeText("127.0.0.1 localhost\n::1 localhost\n")
    File(etc, "apt/apt.conf.d").mkdirs()
    File(etc, "apt/apt.conf.d/99proot").writeText("APT::Sandbox::User \"root\";\n")
  }

  private fun extract(archive: File, destination: File, stripComponents: Int) {
    GZIPInputStream(BufferedInputStream(FileInputStream(archive), 1 shl 16)).use { input ->
      val reader = TarReader(input)
      while (true) {
        val entry = reader.next() ?: return
        val relative = entry.name.removePrefix("./").split('/').drop(stripComponents).joinToString("/")
        if (relative.isEmpty() || relative.split('/').contains("..")) continue
        val target = File(destination, relative.trimEnd('/'))
        target.parentFile?.mkdirs()
        when {
          entry.isDirectory -> {
            target.mkdirs()
            Os.chmod(target.path, entry.mode or 0b111_000_000)
          }
          entry.isSymlink -> {
            target.delete()
            Os.symlink(entry.link, target.path)
          }
          entry.isHardLink -> {
            val source = File(destination, entry.link.removePrefix("./").split('/').drop(stripComponents).joinToString("/"))
            target.delete()
            source.copyTo(target)
            Os.chmod(target.path, entry.mode or 0b110_000_000)
          }
          entry.isFile -> {
            target.delete()
            FileOutputStream(target).use { reader.copyTo(it) }
            Os.chmod(target.path, entry.mode or 0b110_000_000)
          }
        }
      }
    }
  }

  companion object {
    // toybox rm, because Kotlin's recursive delete follows the rootfs's symlinks out of it. Only
    // directories get chmod: chmod -R follows symlinks, and link2symlink's absolute links would let
    // it change files in another environment or in shared storage.
    fun removeTree(directory: File) {
      if (!directory.exists()) return
      val script = "find \"$1\" -type d -exec chmod u+rwx {} + 2>/dev/null; rm -rf \"$1\""
      ProcessBuilder("/system/bin/sh", "-c", script, "sh", directory.path)
        .redirectErrorStream(true)
        .start()
        .apply { inputStream.readBytes() }
        .waitFor()
    }
  }
}
