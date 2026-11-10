package expo.modules.t3localserver

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.StatFs
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.FilterOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.zip.Deflater
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import java.util.zip.ZipException

class MaintenanceCancelled : IOException("Cancelled")

/** Reports progress and answers whether the user cancelled. */
interface MaintenanceProgress {
  fun report(done: Long, total: Long, detail: String)
  fun checkCancelled()
}

/** Where a backup goes. Discard removes a partial file, so a failed backup leaves nothing behind. */
interface BackupSink {
  fun open(): OutputStream
  fun commit(): String
  fun discard()
}

class DownloadsSink(private val context: Context, private val fileName: String) : BackupSink {
  private var item: Uri? = null

  override fun open(): OutputStream {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw IOException("Saving to Downloads needs Android 10 or newer")
    val created = PublicDownloads.insert(context, fileName)
    item = created
    return context.contentResolver.openOutputStream(created) ?: throw IOException("Android could not open the file in Downloads.")
  }

  override fun commit(): String {
    val created = item ?: throw IOException("Nothing was saved")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      context.contentResolver.update(created, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
    }
    return "Downloads/${PublicDownloads.FOLDER}/${displayName(context, created) ?: fileName}"
  }

  override fun discard() {
    item?.let { runCatching { context.contentResolver.delete(it, null, null) } }
  }
}

class DocumentSink(private val context: Context, private val uri: Uri) : BackupSink {
  override fun open(): OutputStream =
    context.contentResolver.openOutputStream(uri, "wt") ?: throw IOException("Android could not open the chosen file.")

  override fun commit() = displayName(context, uri) ?: "the chosen file"

  override fun discard() {
    runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) }
  }
}

internal fun displayName(context: Context, uri: Uri): String? = runCatching {
  context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
    if (it.moveToFirst()) it.getString(0) else null
  }
}.getOrNull()

/**
 * Backs up and restores the Linux environment as one gzip'd GNU tar: `t3-backup.json` first, then
 * `rootfs/...`. It copies the rootfs as Android stores it, outside proot, so proot's link2symlink
 * files, modes and symlinks come back exactly, and it works when Linux itself is broken or gone.
 */
object LinuxBackup {
  const val FORMAT = "t3-squared-linux-backup"
  const val FORMAT_VERSION = 1
  private const val MANIFEST_NAME = "t3-backup.json"
  private const val ROOTFS_PREFIX = "rootfs/"

  /** Directories kept empty: mounts, scratch space and caches that refill themselves. */
  private val EMPTY_DIRECTORIES = setOf(
    "proc", "sys", "dev", "tmp", "var/tmp", "run/t3-usb", GuestRuntime.SHARED_PROJECTS_PATH.removePrefix("/"),
    "root/.npm/_cacache", "root/.cache", "root/.t3/caches", Ollama.MODELS_PATH.removePrefix("/"),
  )
  val EXCLUDED = listOf(
    "/tmp and /var/tmp",
    "apt's downloaded packages (/var/cache/apt)",
    "npm's download cache (/root/.npm/_cacache)",
    "/root/.cache",
    "the shared project folder (/root/shared-projects)",
    "Ollama's downloaded models (/root/.ollama/models)",
  )

  private fun excludedFile(relative: String) =
    (relative.startsWith("var/cache/apt/archives/") && relative.endsWith(".deb")) ||
      (relative.startsWith("var/cache/apt/") && relative.endsWith(".bin") && relative.count { it == '/' } == 3)

  private class Totals(var bytes: Long = 0, var files: Long = 0)

  private fun walk(rootfs: File, visit: (relative: String, file: File, stat: StructStat) -> Unit) {
    fun visitDirectory(directory: File, relative: String) {
      val names = directory.list()?.sorted() ?: return
      for (name in names) {
        val child = File(directory, name)
        val childRelative = if (relative.isEmpty()) name else "$relative/$name"
        val stat = try {
          Os.lstat(child.path)
        } catch (_: ErrnoException) {
          continue
        }
        val isDirectory = OsConstants.S_ISDIR(stat.st_mode)
        if (!isDirectory && excludedFile(childRelative)) continue
        visit(childRelative, child, stat)
        if (isDirectory && childRelative !in EMPTY_DIRECTORIES) visitDirectory(child, childRelative)
      }
    }
    visitDirectory(rootfs, "")
  }

  private fun measure(rootfs: File, progress: MaintenanceProgress): Totals {
    val totals = Totals()
    walk(rootfs) { _, _, stat ->
      if (OsConstants.S_ISREG(stat.st_mode)) {
        totals.bytes += stat.st_size
        totals.files += 1
        if (totals.files % 2000 == 0L) {
          progress.checkCancelled()
          progress.report(0, 0, "Measuring · ${totals.files} files")
        }
      }
    }
    return totals
  }

  fun fileName(now: Date = Date()): String =
    "t3-squared-linux-${SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(now)}.tar.gz"

  fun backup(context: Context, guest: GuestRuntime, sink: BackupSink, progress: MaintenanceProgress): JSONObject {
    if (!guest.rootfs.isDirectory) throw IOException("Linux is not set up, so there is nothing to back up.")
    progress.report(0, 0, "Measuring")
    val totals = measure(guest.rootfs, progress)
    val options = LocalServerOptions(context)
    val manifest = JSONObject()
      .put("format", FORMAT)
      .put("formatVersion", FORMAT_VERSION)
      .put("appVersion", appVersion(context))
      .put("createdAt", isoNow())
      .put("runtimeVersion", GuestRuntime.RUNTIME_VERSION)
      .put("rootfsPath", guest.rootfs.path)
      .put("bytes", totals.bytes)
      .put("files", totals.files)
      .put(
        "contents",
        JSONArray(listOf("Linux and installed packages", "private projects", "Claude Code sign-in and settings", "threads on This phone")),
      )
      .put("excluded", JSONArray(EXCLUDED))
      .put("options", JSONObject().put("sharedStorage", options.sharedStorage).put("startOnAppOpen", options.startOnAppOpen))
    var written = 0L
    var committed = false
    try {
      val counted = CountingOutputStream(sink.open())
      counted.use { raw ->
        val gzip = object : GZIPOutputStream(BufferedOutputStream(raw, 1 shl 16), 1 shl 16) {
          init {
            def.setLevel(Deflater.BEST_SPEED)
          }
        }
        gzip.use { output ->
          val tar = TarWriter(output)
          val mtime = System.currentTimeMillis() / 1000
          tar.bytes(MANIFEST_NAME, manifest.toString(2).toByteArray(), mtime)
          tar.directory(ROOTFS_PREFIX, 0b111_101_101, mtime)
          val hardLinks = HashMap<Pair<Long, Long>, String>()
          walk(guest.rootfs) { relative, file, stat ->
            progress.checkCancelled()
            val name = ROOTFS_PREFIX + relative
            val mode = stat.st_mode and 0b111_111_111_111
            when {
              OsConstants.S_ISDIR(stat.st_mode) -> tar.directory(name, mode, stat.st_mtime)
              OsConstants.S_ISLNK(stat.st_mode) -> tar.symlink(name, Os.readlink(file.path), stat.st_mtime)
              OsConstants.S_ISREG(stat.st_mode) -> {
                val key = stat.st_dev to stat.st_ino
                val first = if (stat.st_nlink > 1) hardLinks.putIfAbsent(key, name) else null
                if (first != null) {
                  tar.hardLink(name, first, mode, stat.st_mtime)
                } else {
                  FileInputStream(file).use { input ->
                    tar.file(name, mode, stat.st_mtime, stat.st_size, input) { count ->
                      written += count
                      progress.report(written, totals.bytes, relative)
                    }
                  }
                }
              }
              // Sockets and pipes belong to processes that are gone; Android allows no device files.
              else -> Unit
            }
          }
          tar.finish()
        }
      }
      val location = sink.commit()
      committed = true
      return JSONObject().put("location", location).put("bytes", totals.bytes).put("fileBytes", counted.count)
    } finally {
      if (!committed) sink.discard()
    }
  }

  /** Reads only the manifest at the front, so checking a multi-gigabyte file is instant. */
  fun readManifest(context: Context, uri: Uri): JSONObject {
    val stream = context.contentResolver.openInputStream(uri) ?: throw IOException("Android could not open the file.")
    return stream.use { manifestFrom(TarReader(gunzip(it))) }.put("fileBytes", sizeOf(context, uri))
  }

  private fun gunzip(input: InputStream) = try {
    GZIPInputStream(BufferedInputStream(input, 1 shl 16), 1 shl 16)
  } catch (error: IOException) {
    throw IOException("This is not a T3² Code Linux backup.", error)
  }

  private fun manifestFrom(reader: TarReader): JSONObject {
    val entry = try {
      reader.next()
    } catch (error: IOException) {
      throw IOException("This is not a T3² Code Linux backup.", error)
    }
    if (entry?.name != MANIFEST_NAME || !entry.isFile) throw IOException("This is not a T3² Code Linux backup.")
    val manifest = JSONObject(reader.text())
    if (manifest.optString("format") != FORMAT) throw IOException("This is not a T3² Code Linux backup.")
    if (manifest.optInt("formatVersion") > FORMAT_VERSION) {
      throw IOException("This backup was made by a newer version of the app. Update the app to restore it.")
    }
    if (manifest.optString("runtimeVersion") != GuestRuntime.RUNTIME_VERSION) {
      throw IOException("This backup's Linux environment is not compatible with this version of the app.")
    }
    return manifest
  }

  private fun sizeOf(context: Context, uri: Uri): Long = runCatching {
    context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
  }.getOrNull()?.takeIf { it > 0 } ?: -1L

  /**
   * Unpacks into a staging directory beside the runtime and swaps it in only once every byte checked
   * out, gzip's CRC included. A failure or a crash at any point leaves the old environment as it was.
   */
  fun restore(context: Context, guest: GuestRuntime, uri: Uri, progress: MaintenanceProgress): JSONObject {
    val paths = MaintenancePaths(context)
    RuntimeInstaller.removeTree(paths.staging)
    val fileBytes = sizeOf(context, uri)
    val stream = context.contentResolver.openInputStream(uri) ?: throw IOException("Android could not open the file.")
    val manifest = try {
      val counter = CountingInputStream(stream)
      gunzip(counter).use { input ->
        val reader = TarReader(input)
        val header = manifestFrom(reader)
        val needed = header.optLong("bytes") + header.optLong("bytes") / 10 + (200L shl 20)
        val free = StatFs(context.filesDir.path).availableBytes
        if (free < needed) {
          throw IOException("Restoring needs about ${needed / (1L shl 20)} MB free, and the phone has ${free / (1L shl 20)} MB.")
        }
        val rootfs = File(paths.staging, "rootfs").apply { mkdirs() }
        // proot resolves /data/user/0 to /data/data and writes links in that form.
        val canonicalRootfs = guest.rootfs.canonicalPath
        val directories = ArrayList<Pair<File, Long>>()
        while (true) {
          progress.checkCancelled()
          val entry = reader.next() ?: break
          if (!entry.name.startsWith(ROOTFS_PREFIX)) continue
          val relative = entry.name.removePrefix(ROOTFS_PREFIX).trimEnd('/')
          if (relative.isEmpty() || relative.split('/').any { it == ".." }) continue
          val target = File(rootfs, relative)
          target.parentFile?.mkdirs()
          when {
            entry.isDirectory -> {
              target.mkdirs()
              Os.chmod(target.path, entry.mode or 0b111_000_000)
              directories.add(target to entry.mtime)
            }
            // link2symlink's links name the rootfs by its absolute path on the phone.
            entry.isSymlink -> Os.symlink(relocate(entry.link, context.packageName, canonicalRootfs), target.path)
            entry.isHardLink -> {
              val source = File(rootfs, entry.link.removePrefix(ROOTFS_PREFIX))
              try {
                Os.link(source.path, target.path)
              } catch (_: ErrnoException) {
                source.copyTo(target, overwrite = true)
                Os.chmod(target.path, entry.mode or 0b110_000_000)
              }
            }
            entry.isFile -> {
              FileOutputStream(target).use { output ->
                reader.copyTo(output) { progress.report(counter.count, fileBytes, relative) }
              }
              Os.chmod(target.path, entry.mode or 0b110_000_000)
              target.setLastModified(entry.mtime * 1000)
            }
          }
          progress.report(counter.count, fileBytes, relative)
        }
        // Reading to the end makes GZIPInputStream check the CRC and length of everything.
        val buffer = ByteArray(1 shl 14)
        while (input.read(buffer) >= 0) progress.checkCancelled()
        directories.asReversed().forEach { (directory, mtime) -> directory.setLastModified(mtime * 1000) }
        header
      }
    } catch (error: Throwable) {
      RuntimeInstaller.removeTree(paths.staging)
      if (error is ZipException || error is EOFException) {
        throw IOException("The backup is damaged or incomplete (${error.message})", error)
      }
      throw error
    }
    progress.report(fileBytes, fileBytes, "Switching to the restored environment")
    File(paths.staging, GuestRuntime.INSTALLED_MARKER).writeText(manifest.optString("runtimeVersion"))
    File(paths.staging, MaintenancePaths.COMPLETE_MARKER).writeText("1")
    paths.recover()
    manifest.optJSONObject("options")?.let {
      val options = LocalServerOptions(context)
      options.sharedStorage = it.optBoolean("sharedStorage", options.sharedStorage)
      options.startOnAppOpen = it.optBoolean("startOnAppOpen", options.startOnAppOpen)
    }
    return manifest
  }

  /** Points link2symlink's absolute links at this phone's rootfs, whichever user or alias made them. */
  private fun relocate(link: String, packageName: String, newRootfs: String): String {
    val match = Regex("""^/data/(?:data|user/\d+)/${Regex.escape(packageName)}/files/runtime/rootfs(?=/|$)""").find(link)
    return if (match == null) link else newRootfs + link.substring(match.range.last + 1)
  }

  private fun appVersion(context: Context) = runCatching {
    context.packageManager.getPackageInfo(context.packageName, 0).versionName
  }.getOrNull() ?: "unknown"

  private fun isoNow() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
    .apply { timeZone = TimeZone.getTimeZone("UTC") }
    .format(Date())
}

private class CountingInputStream(input: InputStream) : FilterInputStream(input) {
  var count = 0L
    private set

  override fun read(): Int = super.read().also { if (it >= 0) count += 1 }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
    super.read(buffer, offset, length).also { if (it > 0) count += it }

  override fun skip(n: Long): Long = super.skip(n).also { count += it }
}

private class CountingOutputStream(output: OutputStream) : FilterOutputStream(output) {
  var count = 0L
    private set

  override fun write(b: Int) {
    out.write(b)
    count += 1
  }

  override fun write(buffer: ByteArray, offset: Int, length: Int) {
    out.write(buffer, offset, length)
    count += length
  }
}

/**
 * The runtime directory and its neighbours during a restore. Every step is a rename, so `recover`
 * can finish or undo an interrupted swap, and a staging directory without its marker is junk.
 */
class MaintenancePaths(context: Context) {
  val runtime = File(context.filesDir, "runtime")
  val staging = File(context.filesDir, "runtime.restore")
  private val old = File(context.filesDir, "runtime.old")

  fun recover() {
    if (File(staging, COMPLETE_MARKER).isFile) {
      if (runtime.exists() && !runtime.renameTo(old)) throw IOException("Could not move the old environment aside")
      if (!staging.renameTo(runtime)) {
        if (!runtime.exists()) old.renameTo(runtime)
        throw IOException("Could not switch to the restored environment")
      }
    } else {
      RuntimeInstaller.removeTree(staging)
      if (!runtime.exists() && old.exists()) old.renameTo(runtime)
    }
    File(runtime, COMPLETE_MARKER).delete()
    RuntimeInstaller.removeTree(old)
  }

  companion object {
    const val COMPLETE_MARKER = ".restore-complete"
  }
}

/**
 * A soft reset moves what the user would miss out of the rootfs, lets the normal first-run install
 * build a fresh one, and moves it back before the install counts as finished.
 */
object KeptFiles {
  private val KEPT = listOf(
    "root/projects", "root/.ssh", "root/.gitconfig", "root/.config/git", "root/.android", "root/.t3",
    // OpenCode's settings, sign-ins and sessions; OpenCode itself is installed again from the app.
    "root/.config/opencode", "root/.local/share/opencode",
  )
  private val DROPPED = listOf("root/.t3/runtime", "root/.t3/caches")

  private fun directory(guest: GuestRuntime) = File(guest.root, "kept")

  fun keptPaths(guest: GuestRuntime): List<String> {
    val claude = File(guest.rootfs, "root").list()?.filter { it.startsWith(".claude") }?.map { "root/$it" }.orEmpty()
    return KEPT + claude
  }

  fun moveAside(guest: GuestRuntime) {
    val kept = directory(guest)
    for (relative in keptPaths(guest)) {
      val source = File(guest.rootfs, relative)
      val target = File(kept, relative)
      if (!source.exists() && !isSymlink(source)) continue
      // An earlier interrupted reset already saved this; the rootfs copy is the newer install's.
      if (target.exists() || isSymlink(target)) continue
      target.parentFile?.mkdirs()
      if (!source.renameTo(target)) throw IOException("Could not keep /$relative")
    }
    DROPPED.forEach { RuntimeInstaller.removeTree(File(kept, it)) }
  }

  /** Moves kept files into the fresh rootfs; a kept file wins over one the install created. */
  fun restore(guest: GuestRuntime) {
    val kept = directory(guest)
    if (!kept.isDirectory) return
    merge(kept, guest.rootfs)
    RuntimeInstaller.removeTree(kept)
  }

  private fun merge(from: File, into: File) {
    for (name in from.list().orEmpty()) {
      val source = File(from, name)
      val target = File(into, name)
      if (source.isDirectory && !isSymlink(source) && target.isDirectory && !isSymlink(target)) {
        merge(source, target)
      } else {
        if (isSymlink(target)) target.delete() else RuntimeInstaller.removeTree(target)
        into.mkdirs()
        if (!source.renameTo(target)) throw IOException("Could not restore ${target.name}")
      }
    }
  }

  private fun isSymlink(file: File) = try {
    OsConstants.S_ISLNK(Os.lstat(file.path).st_mode)
  } catch (_: ErrnoException) {
    false
  }
}
