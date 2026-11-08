package expo.modules.t3localserver

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

private const val BLOCK = 512
private const val NAME_LENGTH = 100
private const val MAX_OCTAL_SIZE = 8L * 1024 * 1024 * 1024 - 1

/** One tar member. Long names come from GNU 'L'/'K' or pax records and are already resolved. */
class TarEntry(
  val name: String,
  val type: Char,
  val mode: Int,
  val size: Long,
  val mtime: Long,
  val link: String,
) {
  val isDirectory get() = type == '5'
  val isSymlink get() = type == '2'
  val isHardLink get() = type == '1'
  val isFile get() = type == '0' || type == '\u0000' || type == '7'
}

/** Reads a tar stream one member at a time, never holding more than a block in memory. */
class TarReader(private val input: InputStream) {
  private val header = ByteArray(BLOCK)
  private var unread = 0L
  private var currentSize = 0L

  fun next(): TarEntry? {
    skipExactly(unread)
    skipExactly(paddingFor(currentSize))
    unread = 0
    currentSize = 0
    var longName: String? = null
    var longLink: String? = null
    var paxPath: String? = null
    var paxLink: String? = null
    while (true) {
      if (!input.readBlock(header) || header.all { it == 0.toByte() }) return null
      val size = header.number(124, 12)
      when (val type = header[156].toInt().toChar()) {
        'L' -> longName = readText(size)
        'K' -> longLink = readText(size)
        'x' -> readText(size).let { records ->
          paxPath = PAX_PATH.find(records)?.groupValues?.get(1)
          paxLink = PAX_LINK.find(records)?.groupValues?.get(1)
        }
        'g' -> readText(size)
        else -> {
          val prefix = if (header.string(257, 5) == "ustar") header.string(345, 155) else ""
          val name = paxPath ?: longName
            ?: listOf(prefix, header.string(0, NAME_LENGTH)).filter { it.isNotEmpty() }.joinToString("/")
          unread = size
          currentSize = size
          return TarEntry(
            name = name,
            type = type,
            mode = header.number(100, 8).toInt(),
            size = size,
            mtime = header.number(136, 12),
            link = paxLink ?: longLink ?: header.string(157, NAME_LENGTH),
          )
        }
      }
    }
  }

  /** Copies the current member's data; `onChunk` sees every chunk and may throw to stop. */
  fun copyTo(output: OutputStream, onChunk: (Int) -> Unit = {}) {
    val buffer = ByteArray(1 shl 16)
    while (unread > 0) {
      val count = input.read(buffer, 0, minOf(buffer.size.toLong(), unread).toInt())
      if (count < 0) throw EOFException("The backup ends early")
      output.write(buffer, 0, count)
      unread -= count
      onChunk(count)
    }
    skipExactly(paddingFor(currentSize))
    currentSize = 0
  }

  /** The current member's data as text, for small members such as a manifest. */
  fun text(): String {
    if (unread > 1 shl 20) throw IOException("A tar member is too large to read as text")
    val output = java.io.ByteArrayOutputStream(unread.toInt())
    copyTo(output)
    return output.toString("UTF-8")
  }

  private fun readText(size: Long): String {
    if (size > 1 shl 20) throw IOException("A tar header is too large")
    val bytes = ByteArray(size.toInt())
    var read = 0
    while (read < bytes.size) {
      val count = input.read(bytes, read, bytes.size - read)
      if (count < 0) throw EOFException("The backup ends early")
      read += count
    }
    skipExactly(paddingFor(size))
    return String(bytes, Charsets.UTF_8).trimEnd('\u0000')
  }

  private fun skipExactly(size: Long) {
    val buffer = ByteArray(1 shl 14)
    var left = size
    while (left > 0) {
      val count = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
      if (count < 0) throw EOFException("The backup ends early")
      left -= count
    }
  }

  private companion object {
    val PAX_PATH = Regex("""\d+ path=(.*)\n""")
    val PAX_LINK = Regex("""\d+ linkpath=(.*)\n""")
  }
}

/** Writes GNU tar: long names as 'L'/'K' members, sizes past 8 GiB in base-256. */
class TarWriter(private val output: OutputStream) {
  private val zeros = ByteArray(BLOCK)

  fun directory(name: String, mode: Int, mtime: Long) = header(name.trimEnd('/') + "/", '5', mode, 0, mtime, "")

  fun symlink(name: String, target: String, mtime: Long) = header(name, '2', 0b111_111_111, 0, mtime, target)

  fun hardLink(name: String, target: String, mode: Int, mtime: Long) = header(name, '1', mode, 0, mtime, target)

  /** Writes exactly `size` bytes: a file that shrank meanwhile is padded, one that grew is cut. */
  fun file(name: String, mode: Int, mtime: Long, size: Long, input: InputStream, onChunk: (Int) -> Unit = {}) {
    header(name, '0', mode, size, mtime, "")
    val buffer = ByteArray(1 shl 16)
    var left = size
    while (left > 0) {
      val count = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
      if (count < 0) break
      output.write(buffer, 0, count)
      left -= count
      onChunk(count)
    }
    while (left > 0) {
      val count = minOf(left, zeros.size.toLong()).toInt()
      output.write(zeros, 0, count)
      left -= count
    }
    output.write(zeros, 0, paddingFor(size).toInt())
  }

  fun bytes(name: String, content: ByteArray, mtime: Long) =
    file(name, 0b110_100_100, mtime, content.size.toLong(), content.inputStream())

  fun finish() {
    output.write(zeros)
    output.write(zeros)
    output.flush()
  }

  private fun header(name: String, type: Char, mode: Int, size: Long, mtime: Long, link: String) {
    val nameBytes = name.toByteArray(Charsets.UTF_8)
    val linkBytes = link.toByteArray(Charsets.UTF_8)
    if (nameBytes.size >= NAME_LENGTH) longMember('L', nameBytes)
    if (linkBytes.size >= NAME_LENGTH) longMember('K', linkBytes)
    val block = ByteArray(BLOCK)
    nameBytes.copyInto(block, 0, 0, minOf(nameBytes.size, NAME_LENGTH - 1))
    block.putOctal(100, 8, (mode and 0b111_111_111_111).toLong())
    block.putOctal(108, 8, 0)
    block.putOctal(116, 8, 0)
    if (size > MAX_OCTAL_SIZE) block.putBase256(124, 12, size) else block.putOctal(124, 12, size)
    block.putOctal(136, 12, mtime.coerceAtLeast(0))
    block[156] = type.code.toByte()
    linkBytes.copyInto(block, 157, 0, minOf(linkBytes.size, NAME_LENGTH - 1))
    "ustar  ".toByteArray().copyInto(block, 257)
    "root".toByteArray().copyInto(block, 265)
    "root".toByteArray().copyInto(block, 297)
    for (index in 148 until 156) block[index] = ' '.code.toByte()
    val checksum = block.sumOf { it.toInt() and 0xff }
    "%06o".format(checksum).toByteArray().copyInto(block, 148)
    block[154] = 0
    block[155] = ' '.code.toByte()
    output.write(block)
  }

  private fun longMember(type: Char, value: ByteArray) {
    val content = value + 0
    header("././@LongLink", type, 0, content.size.toLong(), 0, "")
    output.write(content)
    output.write(zeros, 0, paddingFor(content.size.toLong()).toInt())
  }
}

internal fun paddingFor(size: Long) = (BLOCK - size % BLOCK) % BLOCK

private fun ByteArray.putOctal(offset: Int, length: Int, value: Long) {
  val text = value.toString(8).padStart(length - 1, '0')
  text.toByteArray().copyInto(this, offset)
  this[offset + length - 1] = 0
}

private fun ByteArray.putBase256(offset: Int, length: Int, value: Long) {
  var rest = value
  for (index in offset + length - 1 downTo offset + 1) {
    this[index] = (rest and 0xff).toByte()
    rest = rest shr 8
  }
  this[offset] = 0x80.toByte()
}

private fun ByteArray.string(offset: Int, length: Int): String {
  var end = offset
  while (end < offset + length && this[end] != 0.toByte()) end += 1
  return String(this, offset, end - offset, Charsets.UTF_8)
}

private fun ByteArray.number(offset: Int, length: Int): Long {
  if (this[offset].toInt() and 0x80 != 0) {
    var value = 0L
    for (index in offset + 1 until offset + length) value = (value shl 8) or (this[index].toLong() and 0xff)
    return value
  }
  return string(offset, length).trim().ifEmpty { "0" }.toLong(8)
}

private fun InputStream.readBlock(block: ByteArray): Boolean {
  var read = 0
  while (read < block.size) {
    val count = read(block, read, block.size - read)
    if (count < 0) {
      if (read == 0) return false
      throw EOFException("The backup ends early")
    }
    read += count
  }
  return true
}
