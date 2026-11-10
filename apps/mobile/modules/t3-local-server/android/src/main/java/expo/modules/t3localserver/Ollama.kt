package expo.modules.t3localserver

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Ollama in the Linux environment: installs the official release, runs `ollama serve` while the
 * built-in server runs, and pulls, lists and deletes models over its HTTP API.
 */
object Ollama {
  private const val TAG = "T3Ollama"
  const val PORT = 11434
  const val BASE_URL = "http://127.0.0.1:$PORT"
  private const val RELEASE_URL = "https://github.com/ollama/ollama/releases/latest/download/ollama-linux-arm64.tar.zst"
  private const val PROGRESS_STEP = 0.005

  data class Model(val name: String, val size: Long)

  data class State(
    val installed: Boolean = false,
    val installing: Boolean = false,
    val progress: Double = 0.0,
    val detail: String? = null,
    val error: String? = null,
    val running: Boolean = false,
    val models: List<Model> = emptyList(),
    val pulling: String? = null,
    val pullProgress: Double = 0.0,
    val pullDetail: String? = null,
  ) {
    fun toMap() = mapOf(
      "installed" to installed,
      "installing" to installing,
      "progress" to progress,
      "detail" to detail,
      "error" to error,
      "running" to running,
      "models" to models.map { mapOf("name" to it.name, "size" to it.size.toDouble()) },
      "pulling" to pulling,
      "pullProgress" to pullProgress,
      "pullDetail" to pullDetail,
    )
  }

  @Volatile
  var state = State()
    private set
  private val listeners = CopyOnWriteArraySet<(State) -> Unit>()

  @Volatile
  private var serveProcess: Process? = null
  @Volatile
  private var serving = false

  /** Bumped on each start, so a stopped serve loop never starts another `ollama serve`. */
  @Volatile
  private var serveGeneration = 0

  fun addListener(listener: (State) -> Unit) = listeners.add(listener)

  fun removeListener(listener: (State) -> Unit) = listeners.remove(listener)

  @Synchronized
  private fun update(change: (State) -> State) {
    val next = change(state)
    if (next == state) return
    state = next
    listeners.forEach { it(next) }
  }

  private fun binary(guest: GuestRuntime) = File(guest.rootfs, "usr/local/bin/ollama")

  fun refresh(context: Context): State {
    val installed = binary(GuestRuntime(context)).isFile
    update { it.copy(installed = installed) }
    if (installed && serving) thread(name = "t3-ollama-models") { loadModels() }
    return state
  }

  // ---- install -------------------------------------------------------------------------------

  /** Streams the release through zstd and tar, keeping only what runs on a phone's CPU. */
  fun install(context: Context) {
    if (state.installing) return
    update { it.copy(installing = true, progress = 0.0, detail = "Preparing", error = null) }
    thread(name = "t3-ollama-install") {
      val guest = GuestRuntime(context)
      try {
        val setup = GitSetup(guest).run(
          listOf("sh", "-c", "command -v zstd >/dev/null || (apt-get update && apt-get install -y zstd)"),
          timeoutSeconds = 600,
        )
        if (setup.exitCode != 0) throw IOException("Could not install zstd: ${setup.output.lines().lastOrNull()}")
        File(guest.rootfs, "usr/local/lib/ollama").deleteRecursively()
        download(guest)
        if (!binary(guest).isFile) throw IOException("The download did not contain Ollama")
        update { it.copy(installed = true, installing = false, detail = null, progress = 1.0) }
        if (LocalServerStatusStore.current?.state == LocalServerState.RUNNING) startServe(context)
      } catch (error: Exception) {
        Log.w(TAG, "Ollama install failed", error)
        update { it.copy(installing = false, detail = null, error = error.message ?: error.toString()) }
      }
    }
  }

  private fun download(guest: GuestRuntime) {
    val connection = URL(RELEASE_URL).openConnection() as HttpURLConnection
    connection.connectTimeout = 30_000
    connection.readTimeout = 60_000
    if (connection.responseCode != 200) throw IOException("Download failed: HTTP ${connection.responseCode}")
    val total = connection.contentLengthLong
    val extract = guest.process(
      listOf(
        "sh", "-c",
        "zstd -dc | tar -x -C /usr/local --no-same-owner --exclude='lib/ollama/cuda_*' --exclude='lib/ollama/vulkan*'",
      ),
    ).start()
    val output = StringBuilder()
    val reader = thread(name = "t3-ollama-extract") {
      extract.inputStream.bufferedReader().forEachLine { synchronized(output) { if (output.length < 4_000) output.appendLine(it) } }
    }
    try {
      connection.inputStream.use { input ->
        extract.outputStream.use { sink ->
          val buffer = ByteArray(256 * 1024)
          var done = 0L
          var shown = 0.0
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            sink.write(buffer, 0, count)
            done += count
            val progress = if (total > 0) done.toDouble() / total else 0.0
            if (progress - shown >= PROGRESS_STEP) {
              shown = progress
              update { it.copy(progress = progress, detail = "Downloading ${done / 1_000_000} of ${total / 1_000_000} MB") }
            }
          }
        }
      }
    } catch (error: IOException) {
      ProcessTree.killProcess(extract)
      throw error
    } finally {
      connection.disconnect()
    }
    update { it.copy(detail = "Unpacking") }
    if (!extract.waitFor(10, TimeUnit.MINUTES)) {
      ProcessTree.killProcess(extract)
      throw IOException("Unpacking timed out")
    }
    reader.join(5_000)
    if (extract.exitValue() != 0) throw IOException("Unpacking failed: ${synchronized(output) { output.toString() }.trim().lines().lastOrNull()}")
  }

  /** Removes Ollama and every downloaded model. */
  fun uninstall(context: Context) {
    thread(name = "t3-ollama-uninstall") {
      stopServe()
      val guest = GuestRuntime(context)
      binary(guest).delete()
      File(guest.rootfs, "usr/local/lib/ollama").deleteRecursively()
      File(guest.rootfs, MODELS_PATH.removePrefix("/")).deleteRecursively()
      update { State() }
    }
  }

  // ---- serve ---------------------------------------------------------------------------------

  /** Keeps `ollama serve` running until [stopServe], restarting it if it exits. */
  @Synchronized
  fun startServe(context: Context) {
    val guest = GuestRuntime(context)
    if (serving || !binary(guest).isFile) return
    serving = true
    val generation = ++serveGeneration
    val settings = LocalModelSettings(context)
    thread(name = "t3-ollama-serve") {
      // Inside Linux, so the person or an agent can read why a request failed.
      ServerLog(File(guest.rootfs, LOG_PATH.removePrefix("/")).apply { parentFile?.mkdirs() }).use { log ->
        while (serving && generation == serveGeneration) {
          val process = guest.process(
            listOf(
              "env",
              "OLLAMA_HOST=127.0.0.1:$PORT",
              "OLLAMA_CONTEXT_LENGTH=${settings.effectiveOllamaContext()}",
              // An 8-bit cache needs flash attention and halves the memory the context takes.
              "OLLAMA_FLASH_ATTENTION=1",
              "OLLAMA_KV_CACHE_TYPE=q8_0",
              // Ollama passes this to llama-server, which would otherwise use every core.
              "LLAMA_ARG_THREADS=${settings.effectiveOllamaThreads()}",
              // Ollama reuses the cached instructions while the model stays loaded, so later turns start fast.
              "OLLAMA_KEEP_ALIVE=${settings.ollamaKeepAliveMinutes}m",
              "ollama",
              "serve",
            ),
          ).start()
          serveProcess = process
          thread(name = "t3-ollama-ready") { waitUntilReady() }
          runCatching { process.inputStream.bufferedReader().forEachLine { log.write(it) } }
          process.waitFor()
          update { it.copy(running = false) }
          if (serving && generation == serveGeneration) Thread.sleep(3_000)
        }
      }
    }
  }

  /** Picks up changed [LocalModelSettings]; does nothing while Ollama is not serving. */
  @Synchronized
  fun restartServe(context: Context) {
    if (!serving) return
    stopServe()
    startServe(context)
  }

  /** Frees the memory Ollama's loaded models hold, so the phone GPU has room to load. */
  fun unloadModels() {
    if (!state.running) return
    val loaded = runCatching { JSONObject(request("GET", "/api/ps")).optJSONArray("models") }.getOrNull() ?: return
    for (index in 0 until loaded.length()) {
      val name = loaded.optJSONObject(index)?.optString("name")?.ifEmpty { null } ?: continue
      runCatching {
        val connection = open("POST", "/api/generate")
        connection.outputStream.use { it.write(JSONObject().put("model", name).put("keep_alive", 0).toString().toByteArray()) }
        connection.responseCode
        connection.disconnect()
      }.onFailure { Log.w(TAG, "Could not unload $name", it) }
    }
  }

  @Synchronized
  fun stopServe() {
    serving = false
    serveProcess?.let { ProcessTree.killProcess(it) }
    serveProcess = null
    update { it.copy(running = false) }
  }

  private fun waitUntilReady() {
    repeat(60) {
      if (!serving) return
      if (runCatching { request("GET", "/api/version") }.isSuccess) {
        update { it.copy(running = true) }
        loadModels()
        return
      }
      Thread.sleep(1_000)
    }
  }

  // ---- models --------------------------------------------------------------------------------

  private fun loadModels() {
    val json = runCatching { JSONObject(request("GET", "/api/tags")) }.getOrNull() ?: return
    val array = json.optJSONArray("models") ?: JSONArray()
    val models = (0 until array.length()).mapNotNull { array.optJSONObject(it) }
      .map { Model(it.optString("name"), it.optLong("size")) }
      .sortedBy { it.name }
    update { it.copy(models = models) }
  }

  fun pull(name: String) {
    val model = name.trim()
    if (model.isEmpty() || state.pulling != null || !state.running) return
    update { it.copy(pulling = model, pullProgress = 0.0, pullDetail = "Starting", error = null) }
    thread(name = "t3-ollama-pull") {
      try {
        val connection = open("POST", "/api/pull")
        connection.readTimeout = 0
        connection.outputStream.use { it.write(JSONObject().put("model", model).toString().toByteArray()) }
        if (connection.responseCode != 200) throw IOException(errorOf(connection))
        connection.inputStream.bufferedReader().forEachLine { line ->
          val event = runCatching { JSONObject(line) }.getOrNull() ?: return@forEachLine
          event.optString("error").takeIf { it.isNotEmpty() }?.let { throw IOException(it) }
          val total = event.optLong("total")
          val completed = event.optLong("completed")
          update {
            it.copy(
              pullProgress = if (total > 0) completed.toDouble() / total else it.pullProgress,
              pullDetail = if (total > 0) "${completed / 1_000_000} of ${total / 1_000_000} MB" else event.optString("status"),
            )
          }
        }
        update { it.copy(pulling = null, pullDetail = null) }
      } catch (error: Exception) {
        update { it.copy(pulling = null, pullDetail = null, error = "Could not download $model: ${error.message}") }
      }
      loadModels()
    }
  }

  fun delete(name: String) {
    thread(name = "t3-ollama-delete") {
      runCatching {
        val connection = open("DELETE", "/api/delete")
        connection.outputStream.use { it.write(JSONObject().put("model", name).toString().toByteArray()) }
        if (connection.responseCode != 200) throw IOException(errorOf(connection))
      }.onFailure { error -> update { it.copy(error = "Could not delete $name: ${error.message}") } }
      loadModels()
    }
  }

  private fun open(method: String, path: String): HttpURLConnection =
    (URL(BASE_URL + path).openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = 3_000
      readTimeout = 30_000
      if (method != "GET") {
        doOutput = true
        setRequestProperty("Content-Type", "application/json")
      }
    }

  private fun request(method: String, path: String): String {
    val connection = open(method, path)
    try {
      if (connection.responseCode != 200) throw IOException(errorOf(connection))
      return connection.inputStream.bufferedReader().readText()
    } finally {
      connection.disconnect()
    }
  }

  private fun errorOf(connection: HttpURLConnection): String {
    val body = runCatching { connection.errorStream?.bufferedReader()?.readText() }.getOrNull().orEmpty()
    return runCatching { JSONObject(body).optString("error") }.getOrNull()?.ifEmpty { null } ?: "HTTP ${connection.responseCode}"
  }

  const val MODELS_PATH = "/root/.ollama/models"
  const val LOG_PATH = "/var/log/ollama.log"
}
