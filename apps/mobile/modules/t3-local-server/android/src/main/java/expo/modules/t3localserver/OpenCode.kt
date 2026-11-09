package expo.modules.t3localserver

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet
import kotlin.concurrent.thread

/**
 * OpenCode in the Linux environment, installed with npm so T3's OpenCode provider finds it on
 * PATH. Its config also lists the phone's Ollama and GPU models.
 */
object OpenCode {
  private const val TAG = "T3OpenCode"
  private const val PACKAGE = "opencode-ai"
  private const val CONFIG_PATH = "root/.config/opencode/opencode.json"
  // Our own provider ids, so a provider the user set up under another name is never touched.
  private const val OLLAMA_PROVIDER = "phone-ollama"
  private const val GPU_PROVIDER = "phone-gpu"

  data class State(
    val installed: Boolean = false,
    val version: String? = null,
    val busy: String? = null,
    val detail: String? = null,
    val error: String? = null,
  ) {
    fun toMap() = mapOf(
      "installed" to installed,
      "version" to version,
      "busy" to busy,
      "detail" to detail,
      "error" to error,
    )
  }

  @Volatile
  var state = State()
    private set
  private val listeners = CopyOnWriteArraySet<(State) -> Unit>()

  fun addListener(listener: (State) -> Unit) = listeners.add(listener)

  fun removeListener(listener: (State) -> Unit) = listeners.remove(listener)

  @Synchronized
  private fun update(change: (State) -> State) {
    val next = change(state)
    if (next == state) return
    state = next
    listeners.forEach { it(next) }
  }

  private fun packageJson(guest: GuestRuntime) = File(guest.rootfs, "opt/node/lib/node_modules/$PACKAGE/package.json")

  fun refresh(context: Context): State {
    val manifest = packageJson(GuestRuntime(context))
    val version = runCatching { JSONObject(manifest.readText()).optString("version") }.getOrNull()?.ifEmpty { null }
    update { it.copy(installed = manifest.isFile, version = version) }
    return state
  }

  /** Installs OpenCode, or updates it to the newest release. Blocks until npm is done. */
  fun install(context: Context) = npm(context, "Installing", listOf("npm", "install", "-g", "$PACKAGE@latest"))

  fun remove(context: Context) = npm(context, "Removing", listOf("npm", "uninstall", "-g", PACKAGE))

  private fun npm(context: Context, label: String, command: List<String>) {
    synchronized(this) {
      if (state.busy != null) return
      update { it.copy(busy = label, detail = null, error = null) }
    }
    val result = GitSetup(GuestRuntime(context)).run(command, timeoutSeconds = 900) { line ->
      line.trim().takeIf { it.isNotEmpty() }?.let { detail -> update { it.copy(detail = detail.take(80)) } }
    }
    val error = if (result.exitCode == 0) null else "$label OpenCode failed: ${result.output.lines().lastOrNull { it.isNotBlank() } ?: "exit ${result.exitCode}"}"
    update { it.copy(busy = null, detail = null, error = error) }
    refresh(context)
    lastModels = null
    syncLocalModels(context)
  }

  // ---- local models --------------------------------------------------------------------------

  @Volatile
  private var lastModels: Pair<List<String>?, List<String>>? = null

  @Volatile
  private var watching = false

  /** Keeps OpenCode's model list in step with the phone's models from now on. */
  @Synchronized
  fun watch(context: Context) {
    if (watching) return
    watching = true
    val appContext = context.applicationContext
    Ollama.addListener { syncLocalModels(appContext) }
    PhoneModels.addListener { syncLocalModels(appContext) }
    thread(name = "t3-opencode-sync") {
      refresh(appContext)
      PhoneModels.refresh(appContext)
      syncLocalModels(appContext)
    }
  }

  @Synchronized
  private fun syncLocalModels(context: Context) {
    if (!state.installed) return
    val ollama = Ollama.state
    // Ollama lists its models only while it runs; until then the config keeps what it had.
    val ollamaModels = when {
      !ollama.installed -> emptyList()
      ollama.running -> ollama.models.map { it.name }
      else -> null
    }
    val gpuModels = PhoneModels.state.installed
    if (lastModels == ollamaModels to gpuModels) return
    lastModels = ollamaModels to gpuModels
    val file = File(GuestRuntime(context).rootfs, CONFIG_PATH)
    try {
      val config = if (file.isFile) JSONObject(file.readText()) else JSONObject().put("\$schema", "https://opencode.ai/config.json")
      val before = config.toString()
      val providers = config.optJSONObject("provider") ?: JSONObject()
      if (ollamaModels != null) {
        setProvider(providers, OLLAMA_PROVIDER, ollamaModels) { models ->
          JSONObject()
            .put("npm", "@ai-sdk/openai-compatible")
            .put("name", "Ollama on this phone")
            .put("options", JSONObject().put("baseURL", "${Ollama.BASE_URL}/v1"))
            .put("models", models)
        }
      }
      setProvider(providers, GPU_PROVIDER, gpuModels) { models ->
        JSONObject()
          .put("npm", "@ai-sdk/anthropic")
          .put("name", "Phone GPU")
          .put("options", JSONObject().put("baseURL", "http://127.0.0.1:${PhoneModelEndpoint.PORT}/v1").put("apiKey", "local"))
          .put("models", models)
      }
      if (providers.length() == 0) config.remove("provider") else config.put("provider", providers)
      if (config.toString() == before) return
      file.parentFile?.mkdirs()
      file.writeText(config.toString(2) + "\n")
    } catch (error: Exception) {
      // A config the user broke by hand is left for them to fix.
      Log.w(TAG, "Could not update ${file.path}", error)
    }
  }

  private fun setProvider(providers: JSONObject, id: String, names: List<String>, build: (JSONObject) -> JSONObject) {
    if (names.isEmpty()) {
      providers.remove(id)
      return
    }
    val models = JSONObject()
    names.sorted().forEach { name ->
      val title = PhoneModels.CATALOG.find { it.id == name }?.title ?: name
      models.put(name, JSONObject().put("name", title))
    }
    providers.put(id, build(models))
  }
}
