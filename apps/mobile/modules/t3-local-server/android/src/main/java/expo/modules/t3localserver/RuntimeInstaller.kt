package expo.modules.t3localserver

import android.system.Os
import java.io.BufferedInputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
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
private const val CLAUDE_CODE_VERSION = "2.1.319"

private val GUEST_SETUP = """
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps \
    python3 ripgrep unzip xz-utils less nano
  npm install -g t3@$T3_VERSION @anthropic-ai/claude-code@$CLAUDE_CODE_VERSION
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
    report("Installing tools and Claude Code", 0.35)
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
      val header = ByteArray(512)
      var longName: String? = null
      var longLink: String? = null
      var paxPath: String? = null
      while (true) {
        if (!input.readBlock(header) || header.all { it == 0.toByte() }) return
        val size = header.octal(124, 12)
        val type = header[156].toInt().toChar()
        when (type) {
          'L' -> {
            longName = input.readText(size)
            continue
          }
          'K' -> {
            longLink = input.readText(size)
            continue
          }
          'x' -> {
            paxPath = Regex("""\d+ path=(.*)\n""").find(input.readText(size))?.groupValues?.get(1)
            continue
          }
          'g' -> {
            input.readText(size)
            continue
          }
        }
        val prefix = if (header.string(257, 5) == "ustar") header.string(345, 155) else ""
        val rawName = paxPath ?: longName ?: listOf(prefix, header.string(0, 100))
          .filter { it.isNotEmpty() }
          .joinToString("/")
        val link = longLink ?: header.string(157, 100)
        paxPath = null
        longName = null
        longLink = null
        val relative = rawName.removePrefix("./").split('/').drop(stripComponents).joinToString("/")
        val mode = header.octal(100, 8).toInt()
        val target = File(destination, relative.trimEnd('/'))
        if (relative.isEmpty() || relative.split('/').contains("..")) {
          input.skipBlocks(size)
          continue
        }
        target.parentFile?.mkdirs()
        when (type) {
          '5' -> {
            target.mkdirs()
            Os.chmod(target.path, mode or 0b111_000_000)
          }
          '2' -> {
            target.delete()
            Os.symlink(link, target.path)
          }
          '1' -> {
            val source = File(destination, link.removePrefix("./").split('/').drop(stripComponents).joinToString("/"))
            target.delete()
            source.copyTo(target)
            Os.chmod(target.path, mode or 0b110_000_000)
          }
          '0', '\u0000', '7' -> {
            target.delete()
            FileOutputStream(target).use { output -> input.copyExactly(output, size) }
            input.skipPadding(size)
            Os.chmod(target.path, mode or 0b110_000_000)
          }
          else -> input.skipBlocks(size)
        }
      }
    }
  }

  companion object {
    // toybox rm, because Kotlin's recursive delete follows the rootfs's symlinks out of it.
    fun removeTree(directory: File) {
      if (!directory.exists()) return
      ProcessBuilder("/system/bin/sh", "-c", "chmod -R u+rwx \"$1\" 2>/dev/null; rm -rf \"$1\"", "sh", directory.path)
        .redirectErrorStream(true)
        .start()
        .apply { inputStream.readBytes() }
        .waitFor()
    }
  }
}

private fun ByteArray.string(offset: Int, length: Int): String {
  var end = offset
  while (end < offset + length && this[end] != 0.toByte()) end += 1
  return String(this, offset, end - offset, Charsets.UTF_8)
}

private fun ByteArray.octal(offset: Int, length: Int): Long =
  string(offset, length).trim().ifEmpty { "0" }.toLong(8)

private fun InputStream.readBlock(block: ByteArray): Boolean {
  var read = 0
  while (read < block.size) {
    val count = read(block, read, block.size - read)
    if (count < 0) return false
    read += count
  }
  return true
}

private fun InputStream.copyExactly(output: FileOutputStream, size: Long) {
  val buffer = ByteArray(1 shl 16)
  var left = size
  while (left > 0) {
    val count = read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
    if (count < 0) throw EOFException("Truncated archive")
    output.write(buffer, 0, count)
    left -= count
  }
}

private fun InputStream.skipExactly(size: Long) {
  val buffer = ByteArray(1 shl 14)
  var left = size
  while (left > 0) {
    val count = read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
    if (count < 0) throw EOFException("Truncated archive")
    left -= count
  }
}

private fun InputStream.skipPadding(size: Long) = skipExactly((512 - size % 512) % 512)

private fun InputStream.skipBlocks(size: Long) {
  skipExactly(size)
  skipPadding(size)
}

private fun InputStream.readText(size: Long): String {
  val bytes = ByteArray(size.toInt())
  var read = 0
  while (read < bytes.size) {
    val count = read(bytes, read, bytes.size - read)
    if (count < 0) throw EOFException("Truncated archive")
    read += count
  }
  skipPadding(size)
  return String(bytes, Charsets.UTF_8).trimEnd('\u0000')
}
