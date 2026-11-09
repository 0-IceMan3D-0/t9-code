package expo.modules.t3localserver

import android.content.Context
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Models that run on the phone's GPU through LiteRT-LM, in the app's own process: Linux cannot
 * reach the GPU driver. [PhoneModelEndpoint] serves them to Claude Code in Linux.
 */
object PhoneModels {
  private const val TAG = "T3PhoneModels"
  // Claude Code starts at about 15K tokens. Phones whose GPU cannot hold the larger size get the
  // smaller one.
  private val CONTEXT_SIZES = listOf(32768, 24576)
  private const val IDLE_UNLOAD_MILLIS = 30 * 60_000L
  private const val PROGRESS_STEP = 0.005

  data class CatalogModel(val id: String, val title: String, val url: String, val bytes: Long)

  val CATALOG = listOf(
    CatalogModel(
      "gemma-4-e2b",
      "Gemma 4 E2B",
      "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm",
      2_588_147_712,
    ),
    CatalogModel(
      "gemma-4-e4b",
      "Gemma 4 E4B",
      "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it.litertlm",
      3_659_530_240,
    ),
  )

  data class State(
    val installed: List<String> = emptyList(),
    val downloading: String? = null,
    val progress: Double = 0.0,
    val error: String? = null,
    val running: Boolean = false,
    val loaded: String? = null,
    /** The loaded model's context size in tokens. */
    val contextTokens: Int = 0,
    val busy: Boolean = false,
  ) {
    fun toMap() = mapOf(
      "catalog" to CATALOG.map { mapOf("id" to it.id, "title" to it.title, "bytes" to it.bytes.toDouble()) },
      "installed" to installed,
      "downloading" to downloading,
      "progress" to progress,
      "error" to error,
      "running" to running,
      "loaded" to loaded,
      "contextTokens" to contextTokens,
      "busy" to busy,
    )
  }

  @Volatile
  var state = State()
    private set
  private val listeners = CopyOnWriteArraySet<(State) -> Unit>()

  fun addListener(listener: (State) -> Unit) = listeners.add(listener)

  fun removeListener(listener: (State) -> Unit) = listeners.remove(listener)

  @Synchronized
  internal fun update(change: (State) -> State) {
    val next = change(state)
    if (next == state) return
    state = next
    listeners.forEach { it(next) }
  }

  private fun directory(context: Context) = File(context.filesDir, "phone-models").apply { mkdirs() }

  private fun file(context: Context, id: String) = File(directory(context), "$id.litertlm")

  fun refresh(context: Context): State {
    val installed = CATALOG.filter { file(context, it.id).isFile }.map { it.id }
    update { it.copy(installed = installed) }
    return state
  }

  // ---- download ------------------------------------------------------------------------------

  @Volatile
  private var cancelDownload = false

  /** Resumes a partial download, so a dropped connection costs only what was not saved yet. */
  fun download(context: Context, id: String) {
    val model = CATALOG.find { it.id == id } ?: return
    if (state.downloading != null) return
    cancelDownload = false
    update { it.copy(downloading = id, progress = 0.0, error = null) }
    thread(name = "t3-phone-model-download") {
      val partial = File(directory(context), "$id.part")
      try {
        val connection = URL(model.url).openConnection() as HttpURLConnection
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        val start = partial.length()
        if (start > 0) connection.setRequestProperty("Range", "bytes=$start-")
        val code = connection.responseCode
        if (code != 200 && code != 206) throw IOException("Download failed: HTTP $code")
        var done = if (code == 206) start else 0L
        RandomAccessFile(partial, "rw").use { out ->
          out.setLength(done)
          out.seek(done)
          connection.inputStream.use { input ->
            val buffer = ByteArray(256 * 1024)
            var shown = 0.0
            while (true) {
              if (cancelDownload) throw IOException("Cancelled")
              val count = input.read(buffer)
              if (count < 0) break
              out.write(buffer, 0, count)
              done += count
              val progress = done.toDouble() / model.bytes
              if (progress - shown >= PROGRESS_STEP) {
                shown = progress
                update { it.copy(progress = progress) }
              }
            }
          }
        }
        connection.disconnect()
        if (partial.length() != model.bytes) throw IOException("The download is incomplete")
        if (!partial.renameTo(file(context, id))) throw IOException("Could not save the model")
        update { it.copy(downloading = null, progress = 1.0) }
      } catch (error: Exception) {
        Log.w(TAG, "Download of $id failed", error)
        update {
          it.copy(downloading = null, error = if (cancelDownload) null else "Could not download ${model.title}: ${error.message}")
        }
      }
      refresh(context)
    }
  }

  fun cancelDownload() {
    cancelDownload = true
  }

  fun delete(context: Context, id: String) {
    thread(name = "t3-phone-model-delete") {
      synchronized(engineLock) { if (loadedId == id) unloadLocked() }
      file(context, id).delete()
      File(directory(context), "$id.part").delete()
      refresh(context)
    }
  }

  // ---- engine --------------------------------------------------------------------------------

  private val engineLock = Any()
  private var engine: Engine? = null
  private var loadedId: String? = null
  private val idleTimer = Executors.newSingleThreadScheduledExecutor()
  private var idleUnload: ScheduledFuture<*>? = null

  /**
   * Runs [block] with the engine for [requested], or the loaded or first installed model when
   * [requested] is not one of ours, such as Claude Code asking for a Claude model by name.
   * Requests take turns: the GPU holds one model and runs one conversation at a time.
   */
  fun <T> withEngine(context: Context, requested: String, block: (Engine, String) -> T): T = synchronized(engineLock) {
    val installed = refresh(context).installed
    val id = requested.takeIf { it in installed } ?: loadedId?.takeIf { it in installed } ?: installed.firstOrNull()
      ?: throw IOException("No phone model is downloaded")
    if (loadedId != id) {
      unloadLocked()
      engine = load(context, id)
      loadedId = id
    }
    update { it.copy(busy = true) }
    try {
      block(engine!!, id)
    } finally {
      update { it.copy(busy = false) }
      idleUnload?.cancel(false)
      idleUnload = idleTimer.schedule({ unload() }, IDLE_UNLOAD_MILLIS, TimeUnit.MILLISECONDS)
    }
  }

  private fun load(context: Context, id: String): Engine {
    val path = file(context, id).absolutePath
    val cache = File(context.cacheDir, "litert").apply { mkdirs() }.absolutePath
    val title = CATALOG.first { it.id == id }.title
    // No CPU fallback: at this context size it needs several GB, and Android then kills the app
    // with the built-in server in it. Ollama is the CPU path.
    var failure: Throwable? = null
    for (tokens in CONTEXT_SIZES) {
      val engine = Engine(EngineConfig(modelPath = path, backend = Backend.GPU(), maxNumTokens = tokens, cacheDir = cache))
      try {
        engine.initialize()
        update { it.copy(loaded = id, contextTokens = tokens, error = null) }
        return engine
      } catch (error: Throwable) {
        Log.w(TAG, "GPU could not load $id with $tokens tokens", error)
        runCatching { engine.close() }
        failure = error
      }
    }
    val message = "This phone's GPU could not load $title. Use Ollama on this phone instead."
    update { it.copy(error = message) }
    throw IOException(message, failure)
  }

  /** Kept open between requests so the next one reuses what it has read; closed before its engine. */
  internal var openConversation: Conversation? = null

  internal fun closeOpenConversation() {
    runCatching { openConversation?.close() }
    openConversation = null
  }

  private fun unloadLocked() {
    closeOpenConversation()
    runCatching { engine?.close() }
    engine = null
    loadedId = null
    update { it.copy(loaded = null, contextTokens = 0) }
  }

  fun unload() = synchronized(engineLock) { unloadLocked() }
}
