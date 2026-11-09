package expo.modules.t3localserver

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile

/**
 * Direct access to the files the phone owns, for the file explorer: Linux's rootfs, which the app
 * stores in its own data folder, and shared phone storage. Paths are the ones users know, such as
 * `/root/notes.md` in Linux or `/Download/a.pdf` on the phone.
 */
class LocalFiles(private val context: Context, private val guest: GuestRuntime) {
  private class Volume(
    val root: File,
    /** Guest paths that proot binds elsewhere. */
    val binds: Map<String, File>,
    /** Linux symlinks point at guest paths, phone storage ones at host paths below the root. */
    val guestLinks: Boolean,
    val protectedPaths: List<String>,
  )

  private class Resolved(val path: String, val file: File)

  private fun volume(id: String): Volume = when (id) {
    "linux" -> {
      if (!guest.rootfs.isDirectory) throw failure("ERR_NOT_INSTALLED", "Linux is not set up yet.")
      val shared = File(Environment.getExternalStorageDirectory(), "T3Projects")
      Volume(
        guest.rootfs,
        if (LocalServerOptions(context).sharedStorage && shared.isDirectory) {
          mapOf(GuestRuntime.SHARED_PROJECTS_PATH to shared)
        } else {
          emptyMap()
        },
        guestLinks = true,
        // The built-in server's database and secrets; deleting them breaks the server.
        protectedPaths = listOf("/root/.t3/userdata"),
      )
    }
    "phone" -> {
      if (!storageGranted()) {
        throw failure("ERR_STORAGE_ACCESS", "Allow T3² Code to manage all files to browse phone storage.")
      }
      Volume(Environment.getExternalStorageDirectory(), emptyMap(), guestLinks = false, protectedPaths = emptyList())
    }
    else -> throw failure("ERR_INVALID_PATH", "Unknown storage '$id'.")
  }

  fun storageGranted() =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

  private fun segments(path: String) = path.split('/').filter { it.isNotEmpty() && it != "." }

  private fun virtual(parts: List<String>) = "/" + parts.joinToString("/")

  private fun host(volume: Volume, parts: List<String>): File {
    val path = virtual(parts)
    val bind = volume.binds.entries
      .filter { path == it.key || path.startsWith(it.key + "/") }
      .maxByOrNull { it.key.length }
    return if (bind != null) File(bind.value, path.removePrefix(bind.key).removePrefix("/"))
    else File(volume.root, parts.joinToString("/"))
  }

  /** Follows symlinks the way the guest would, so a link can never reach outside the volume. */
  private fun resolve(volume: Volume, path: String, followLast: Boolean): Resolved {
    val resolved = ArrayDeque<String>()
    val pending = ArrayDeque(segments(path))
    var hops = 0
    while (pending.isNotEmpty()) {
      val part = pending.removeFirst()
      if (part == "..") {
        resolved.removeLastOrNull()
        continue
      }
      resolved.addLast(part)
      if (pending.isEmpty() && !followLast) break
      val file = host(volume, resolved)
      val stat = lstatOrNull(file) ?: continue
      if (!OsConstants.S_ISLNK(stat.st_mode)) continue
      if (++hops > 40) throw failure("ERR_INVALID_PATH", "'$path' has too many links.")
      val target = Os.readlink(file.path)
      resolved.removeLast()
      val linkParts = if (target.startsWith("/")) {
        resolved.clear()
        if (volume.guestLinks) {
          segments(target)
        } else {
          val inside = target.removePrefix(volume.root.path)
          if (inside == target) throw failure("ERR_INVALID_PATH", "'$path' links outside phone storage.")
          segments(inside)
        }
      } else {
        segments(target)
      }
      linkParts.asReversed().forEach(pending::addFirst)
    }
    return Resolved(virtual(resolved), host(volume, resolved))
  }

  private fun lstatOrNull(file: File): StructStat? = try {
    Os.lstat(file.path)
  } catch (_: ErrnoException) {
    null
  }

  private fun statOrNull(volume: Volume, path: String): StructStat? = try {
    Os.stat(resolve(volume, path, followLast = true).file.path)
  } catch (_: Exception) {
    null
  }

  private fun child(parent: String, name: String) = if (parent == "/") "/$name" else "$parent/$name"

  private fun checkName(name: String) {
    if (name.isEmpty() || name == "." || name == ".." || name.contains('/')) {
      throw failure("ERR_INVALID_PATH", "'$name' is not a valid name.")
    }
  }

  private fun guardWritable(volume: Volume, path: String) {
    val normalized = virtual(segments(path))
    if (normalized == "/") throw failure("ERR_PERMISSION", "The top folder cannot be changed.")
    for (protected in volume.protectedPaths) {
      if (normalized == protected || normalized.startsWith("$protected/") || protected.startsWith("$normalized/")) {
        throw failure("ERR_PERMISSION", "'$normalized' holds the built-in server's data and cannot be changed here.")
      }
    }
  }

  /** The entry itself, not where a final symlink points, for rename, delete and create. */
  private fun entry(volume: Volume, path: String): Resolved {
    val parts = segments(path)
    if (parts.isEmpty()) return Resolved("/", volume.root)
    val name = parts.last()
    checkName(name)
    val parent = resolve(volume, virtual(parts.dropLast(1)), followLast = true)
    return Resolved(child(parent.path, name), File(parent.file, name))
  }

  private fun entryJson(volume: Volume, directory: String, name: String, file: File): JSONObject {
    val lstat = lstatOrNull(file)
    val link = lstat != null && OsConstants.S_ISLNK(lstat.st_mode)
    // proot's link2symlink stores hard links as symlinks to hidden ".l2s." files.
    val stat = if (link) statOrNull(volume, child(directory, name)) else lstat
    val kind = when {
      stat == null -> "other"
      OsConstants.S_ISDIR(stat.st_mode) -> "directory"
      OsConstants.S_ISREG(stat.st_mode) -> "file"
      else -> "other"
    }
    return JSONObject()
      .put("name", name)
      .put("kind", kind)
      .put("symlink", link && !(runCatching { Os.readlink(file.path) }.getOrNull()?.contains(".l2s.") ?: false))
      .apply {
        if (stat != null && kind == "file") put("byteLength", stat.st_size)
        if (stat != null) put("modifiedAt", stat.st_mtime * 1000)
      }
  }

  fun list(volumeId: String, path: String): String {
    val volume = volume(volumeId)
    val directory = resolve(volume, path, followLast = true)
    val names = directory.file.list()
      ?: throw if (directory.file.exists()) failure("ERR_PERMISSION", "'${directory.path}' cannot be read.")
      else failure("ERR_NOT_FOUND", "'${directory.path}' does not exist.")
    // A bind target is not inside the parent folder on disk.
    val bound = volume.binds.keys
      .filter { it.substringBeforeLast('/').ifEmpty { "/" } == directory.path }
      .map { it.substringAfterLast('/') }
    val all = (names.asList() + bound).distinct().filter { !it.startsWith(".l2s.") }
    val entries = JSONArray()
    for (name in all.take(LIST_LIMIT)) entries.put(entryJson(volume, directory.path, name, File(directory.file, name)))
    val parent = segments(directory.path).dropLast(1)
    return JSONObject()
      .put("path", directory.path)
      .put("parentPath", if (directory.path == "/") JSONObject.NULL else virtual(parent))
      .put("homePath", if (volumeId == "linux") "/root" else "/")
      .put("separator", "/")
      .put("entries", entries)
      .put("truncated", all.size > LIST_LIMIT)
      .toString()
  }

  fun stat(volumeId: String, path: String): String {
    val volume = volume(volumeId)
    val target = entry(volume, path)
    val parent = segments(target.path).dropLast(1)
    if (lstatOrNull(target.file) == null) throw failure("ERR_NOT_FOUND", "'${target.path}' does not exist.")
    return entryJson(volume, virtual(parent), target.file.name, target.file)
      .put("path", target.path)
      .put("hostPath", resolve(volume, path, followLast = true).file.path)
      .toString()
  }

  fun createDirectory(volumeId: String, path: String) {
    val volume = volume(volumeId)
    guardWritable(volume, path)
    val target = entry(volume, path)
    errno(target.path) { Os.mkdir(target.file.path, 0b111_101_101) }
  }

  fun createFile(volumeId: String, path: String) {
    val volume = volume(volumeId)
    guardWritable(volume, path)
    val target = entry(volume, path)
    if (!target.file.createNewFile()) throw failure("ERR_EXISTS", "'${target.path}' already exists.")
  }

  fun rename(volumeId: String, from: String, to: String) {
    val volume = volume(volumeId)
    guardWritable(volume, from)
    guardWritable(volume, to)
    val source = entry(volume, from)
    val target = entry(volume, to)
    if (target.path.startsWith(source.path + "/")) throw failure("ERR_INVALID_PATH", "A folder cannot be moved into itself.")
    if (lstatOrNull(target.file) != null && !source.path.equals(target.path, ignoreCase = true)) {
      throw failure("ERR_EXISTS", "'${target.path}' already exists.")
    }
    try {
      Os.rename(source.file.path, target.file.path)
    } catch (error: ErrnoException) {
      // Linux and phone storage are different file systems, so moving between them copies.
      if (error.errno != OsConstants.EXDEV) throw errnoFailure(source.path, error)
      copyTree(source.file, target.file)
      deleteTree(source.file)
    }
  }

  fun copy(fromVolumeId: String, from: String, toVolumeId: String, to: String) {
    val sourceVolume = volume(fromVolumeId)
    val targetVolume = volume(toVolumeId)
    guardWritable(targetVolume, to)
    val source = entry(sourceVolume, from)
    val target = entry(targetVolume, to)
    if (fromVolumeId == toVolumeId && target.path.startsWith(source.path + "/")) {
      throw failure("ERR_INVALID_PATH", "A folder cannot be copied into itself.")
    }
    if (lstatOrNull(target.file) != null) throw failure("ERR_EXISTS", "'${target.path}' already exists.")
    copyTree(source.file, target.file)
  }

  /** Moves between Linux and phone storage, which `rename` cannot reach across. */
  fun move(fromVolumeId: String, from: String, toVolumeId: String, to: String) {
    if (fromVolumeId == toVolumeId) return rename(fromVolumeId, from, to)
    guardWritable(volume(fromVolumeId), from)
    copy(fromVolumeId, from, toVolumeId, to)
    deleteTree(entry(volume(fromVolumeId), from).file)
  }

  fun delete(volumeId: String, paths: List<String>) {
    val volume = volume(volumeId)
    val targets = paths.map {
      guardWritable(volume, it)
      entry(volume, it)
    }
    for (target in targets) {
      if (lstatOrNull(target.file) == null) throw failure("ERR_NOT_FOUND", "'${target.path}' does not exist.")
      deleteTree(target.file)
    }
  }

  private fun copyTree(source: File, target: File) {
    val stat = Os.lstat(source.path)
    when {
      OsConstants.S_ISLNK(stat.st_mode) -> errno(target.path) { Os.symlink(Os.readlink(source.path), target.path) }
      OsConstants.S_ISDIR(stat.st_mode) -> {
        errno(target.path) { Os.mkdir(target.path, stat.st_mode and 0b111_111_111) }
        source.list()?.forEach { copyTree(File(source, it), File(target, it)) }
      }
      OsConstants.S_ISREG(stat.st_mode) -> {
        FileInputStream(source).use { input -> FileOutputStream(target).use { input.copyTo(it, 1 shl 16) } }
        runCatching { Os.chmod(target.path, stat.st_mode and 0b111_111_111) }
        target.setLastModified(stat.st_mtime * 1000)
      }
    }
  }

  private fun deleteTree(file: File) {
    val stat = lstatOrNull(file) ?: return
    if (OsConstants.S_ISDIR(stat.st_mode)) {
      // Linux packages leave read-only folders, which must be writable before their files go.
      runCatching { Os.chmod(file.path, (stat.st_mode and 0b111_111_111) or 0b111_000_000) }
      file.list()?.forEach { deleteTree(File(file, it)) }
      errno(file.path) { Os.remove(file.path) }
    } else {
      errno(file.path) { Os.remove(file.path) }
    }
  }

  fun readText(volumeId: String, path: String, maxBytes: Int): String {
    val target = resolve(volume(volumeId), path, followLast = true)
    if (!target.file.isFile) throw failure("ERR_NOT_FOUND", "'${target.path}' is not a file.")
    val length = target.file.length()
    val bytes = FileInputStream(target.file).use { it.readUpTo(maxBytes) }
    val binary = bytes.take(8000).any { it == 0.toByte() }
    return JSONObject()
      .put("contents", if (binary) "" else String(bytes, Charsets.UTF_8))
      .put("byteLength", length)
      .put("truncated", length > bytes.size)
      .put("binary", binary)
      .put("modifiedAt", target.file.lastModified())
      .toString()
  }

  /** Writes beside the file and renames over it, so a failed save never leaves half a file. */
  fun writeText(volumeId: String, path: String, contents: String, expectedModifiedAt: Double?) {
    val volume = volume(volumeId)
    guardWritable(volume, path)
    val target = resolve(volume, path, followLast = true)
    if (expectedModifiedAt != null && target.file.exists() && target.file.lastModified() != expectedModifiedAt.toLong()) {
      throw failure("ERR_CHANGED", "'${target.path}' changed since it was opened. Reload it before saving.")
    }
    val mode = lstatOrNull(target.file)?.st_mode?.and(0b111_111_111)
    val temporary = File(target.file.parentFile, ".${target.file.name}.t3-save")
    FileOutputStream(temporary).use { it.write(contents.toByteArray(Charsets.UTF_8)) }
    if (mode != null) runCatching { Os.chmod(temporary.path, mode) }
    errno(target.path) { Os.rename(temporary.path, target.file.path) }
  }

  fun readBase64(volumeId: String, path: String, offset: Double, length: Int): String {
    val target = resolve(volume(volumeId), path, followLast = true)
    RandomAccessFile(target.file, "r").use { file ->
      file.seek(offset.toLong())
      val buffer = ByteArray(length.coerceIn(0, 1 shl 20))
      val read = file.read(buffer).coerceAtLeast(0)
      return Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP)
    }
  }

  fun importFile(volumeId: String, path: String, sourceUri: String) {
    val volume = volume(volumeId)
    guardWritable(volume, path)
    val target = entry(volume, path)
    if (lstatOrNull(target.file) != null) throw failure("ERR_EXISTS", "'${target.path}' already exists.")
    val uri = Uri.parse(sourceUri)
    val input: InputStream = (if (uri.scheme == "file") FileInputStream(uri.path!!) else context.contentResolver.openInputStream(uri))
      ?: throw failure("ERR_IO", "The picked file could not be read.")
    input.use { source -> FileOutputStream(target.file).use { source.copyTo(it, 1 shl 16) } }
  }

  fun saveToDownloads(volumeId: String, path: String): String {
    val target = resolve(volume(volumeId), path, followLast = true)
    if (!target.file.isFile) throw failure("ERR_NOT_FOUND", "Only files can be saved to Downloads.")
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      val folder = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), PublicDownloads.FOLDER)
      folder.mkdirs()
      val copy = File(folder, target.file.name)
      target.file.copyTo(copy, overwrite = false)
      return copy.name
    }
    val resolver = context.contentResolver
    val item = PublicDownloads.insert(context, target.file.name)
    try {
      (resolver.openOutputStream(item) ?: throw IOException("Android could not open the file in Downloads.")).use { output ->
        FileInputStream(target.file).use { it.copyTo(output, 1 shl 16) }
      }
      resolver.update(item, android.content.ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
    } catch (error: Exception) {
      resolver.delete(item, null, null)
      throw error
    }
    return target.file.name
  }

  fun fileUri(volumeId: String, path: String): String =
    Uri.fromFile(resolve(volume(volumeId), path, followLast = true).file).toString()

  fun open(volumeId: String, path: String, share: Boolean) {
    val file = resolve(volume(volumeId), path, followLast = true).file
    if (!file.isFile) throw failure("ERR_NOT_FOUND", "Only files can be opened in another app.")
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.SharingFileProvider", file)
    val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "*/*"
    val intent = if (share) {
      Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri)
    } else {
      Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
    }
    intent.clipData = ClipData.newRawUri(file.name, uri)
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    val chooser = Intent.createChooser(intent, if (share) "Share ${file.name}" else "Open ${file.name} with")
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(chooser)
  }

  /** Names containing `query` below `path`, without following symlinks, nearest first. */
  fun search(volumeId: String, path: String, query: String, limit: Int): String {
    val volume = volume(volumeId)
    val start = resolve(volume, path, followLast = true)
    val needle = query.lowercase()
    val results = JSONArray()
    val deadline = System.currentTimeMillis() + SEARCH_BUDGET_MS
    val queue = ArrayDeque(listOf(start.path to start.file))
    var truncated = false
    while (queue.isNotEmpty()) {
      if (results.length() >= limit || System.currentTimeMillis() > deadline) {
        truncated = true
        break
      }
      val (virtualDirectory, directory) = queue.removeFirst()
      for (name in directory.list()?.sorted() ?: continue) {
        if (name.startsWith(".l2s.")) continue
        val file = File(directory, name)
        val stat = lstatOrNull(file) ?: continue
        val childPath = child(virtualDirectory, name)
        if (name.lowercase().contains(needle)) {
          results.put(entryJson(volume, virtualDirectory, name, file).put("path", childPath))
          if (results.length() >= limit) break
        }
        if (OsConstants.S_ISDIR(stat.st_mode) && childPath !in SKIPPED_SEARCH_PATHS) queue.addLast(childPath to file)
      }
    }
    return JSONObject().put("entries", results).put("truncated", truncated).toString()
  }

  fun size(volumeId: String, path: String): String {
    val start = resolve(volume(volumeId), path, followLast = true).file
    var bytes = 0L
    var files = 0L
    var folders = 0L
    val deadline = System.currentTimeMillis() + SIZE_BUDGET_MS
    var complete = true
    fun walk(file: File) {
      if (System.currentTimeMillis() > deadline) {
        complete = false
        return
      }
      val stat = lstatOrNull(file) ?: return
      if (OsConstants.S_ISDIR(stat.st_mode)) {
        folders++
        file.list()?.forEach { walk(File(file, it)) }
      } else {
        files++
        bytes += stat.st_size
      }
    }
    walk(start)
    return JSONObject()
      .put("byteLength", bytes)
      .put("files", files)
      .put("folders", (folders - 1).coerceAtLeast(0))
      .put("complete", complete)
      .toString()
  }

  private fun InputStream.readUpTo(maxBytes: Int): ByteArray {
    val buffer = ByteArray(maxBytes)
    var total = 0
    while (total < maxBytes) {
      val count = read(buffer, total, maxBytes - total)
      if (count < 0) break
      total += count
    }
    return buffer.copyOf(total)
  }

  private fun <T> errno(path: String, work: () -> T): T = try {
    work()
  } catch (error: ErrnoException) {
    throw errnoFailure(path, error)
  }

  private fun errnoFailure(path: String, error: ErrnoException): CodedException = when (error.errno) {
    OsConstants.EEXIST, OsConstants.ENOTEMPTY -> failure("ERR_EXISTS", "'$path' already exists.")
    OsConstants.ENOENT -> failure("ERR_NOT_FOUND", "'$path' does not exist.")
    OsConstants.EACCES, OsConstants.EPERM, OsConstants.EROFS -> failure("ERR_PERMISSION", "'$path' cannot be changed.")
    OsConstants.ENOSPC -> failure("ERR_IO", "The phone is out of storage.")
    else -> failure("ERR_IO", "'$path': ${error.message}")
  }

  private fun failure(code: String, message: String) = CodedException(code, message, null)

  companion object {
    private const val LIST_LIMIT = 5000
    private const val SEARCH_BUDGET_MS = 8_000L
    private const val SIZE_BUDGET_MS = 10_000L
    private val SKIPPED_SEARCH_PATHS = setOf("/proc", "/sys", "/dev")
  }
}
