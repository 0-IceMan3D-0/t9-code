package expo.modules.t3localserver

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import kotlin.concurrent.thread

/**
 * T3's Pi provider installs it without npm scripts. Its settings and sign-ins in ~/.pi stay when
 * it is removed, and its models.json also lists the phone's Ollama and GPU models.
 */
object Pi : NpmTool("Pi", "@earendil-works/pi-coding-agent", installFlags = listOf("--ignore-scripts")) {
  private const val TAG = "T3Pi"
  private const val AGENT_DIR = "root/.pi/agent"
  // Our own provider ids, so a provider the user set up under another name is never touched.
  private const val OLLAMA_PROVIDER = "phone-ollama"
  private const val GPU_PROVIDER = "phone-gpu"
  // Until the GPU has loaded once, Pi is told the usual size; it would otherwise assume 128K and
  // never compact.
  private const val DEFAULT_GPU_CONTEXT = 24576
  private const val GPU_MAX_TOKENS = 4096
  private val PROVIDER_ID = Regex("[a-z0-9-]{1,64}")

  override fun changed(context: Context) {
    lastModels = null
    syncLocalModels(context)
  }

  /** After [LocalModelSettings] change, so Pi plans with the new context sizes. */
  fun settingsChanged(context: Context) = syncLocalModels(context)

  // ---- local models --------------------------------------------------------------------------

  @Volatile
  private var lastModels: List<Any?>? = null

  @Volatile
  private var watching = false

  /** Keeps Pi's model list in step with the phone's models from now on. */
  @Synchronized
  fun watch(context: Context) {
    if (watching) return
    watching = true
    val appContext = context.applicationContext
    Ollama.addListener { syncLocalModels(appContext) }
    PhoneModels.addListener { syncLocalModels(appContext) }
    thread(name = "t3-pi-sync") {
      refresh(appContext)
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
    val settings = LocalModelSettings(context)
    val ollamaContext = settings.effectiveOllamaContext()
    val gpuContext = settings.gpuContext.takeIf { it > 0 } ?: PhoneModels.workingContext(context) ?: DEFAULT_GPU_CONTEXT
    val current = listOf(ollamaModels, gpuModels, ollamaContext, gpuContext)
    if (lastModels == current) return
    lastModels = current
    val file = agentFile(context, "models.json")
    try {
      val config = if (file.isFile) JSONObject(file.readText()) else JSONObject().put("\$schema", "https://pi.dev/schemas/models.schema.json")
      val before = config.toString()
      val providers = config.optJSONObject("providers") ?: JSONObject()
      if (ollamaModels != null) {
        setProvider(providers, OLLAMA_PROVIDER, ollamaModels, JSONObject()
          .put("name", "Ollama on this phone")
          .put("baseUrl", "${Ollama.BASE_URL}/v1")
          .put("api", "openai-completions")
          .put("apiKey", "ollama")) { it.put("contextWindow", ollamaContext) }
      }
      setProvider(providers, GPU_PROVIDER, gpuModels, JSONObject()
        .put("name", "Phone GPU")
        .put("baseUrl", "http://127.0.0.1:${PhoneModelEndpoint.PORT}")
        .put("api", "anthropic-messages")
        .put("apiKey", "local")) { model ->
        model.put("contextWindow", gpuContext).put("maxTokens", GPU_MAX_TOKENS)
      }
      if (providers.length() == 0) config.remove("providers") else config.put("providers", providers)
      if (config.toString() == before) return
      writePrivate(file, config.toString(2) + "\n")
    } catch (error: Exception) {
      // A config the user broke by hand is left for them to fix.
      Log.w(TAG, "Could not update ${file.path}", error)
    }
  }

  private fun setProvider(
    providers: JSONObject,
    id: String,
    names: List<String>,
    provider: JSONObject,
    model: (JSONObject) -> JSONObject,
  ) {
    if (names.isEmpty()) {
      providers.remove(id)
      return
    }
    val models = JSONArray()
    names.sorted().forEach { name ->
      val title = PhoneModels.CATALOG.find { it.id == name }?.title ?: name
      models.put(model(JSONObject().put("id", name).put("name", title)))
    }
    providers.put(id, provider.put("models", models))
  }

  // ---- sign-in -------------------------------------------------------------------------------

  /** Providers with a saved sign-in or API key, as Pi's auth.json names them. */
  fun signedIn(context: Context): List<String> {
    val file = agentFile(context, "auth.json")
    if (!file.isFile) return emptyList()
    return runCatching { JSONObject(file.readText()).keys().asSequence().toList().sorted() }.getOrDefault(emptyList())
  }

  /** Saves the key the way `pi auth login <provider> --api-key` does. */
  @Synchronized
  fun saveApiKey(context: Context, provider: String, key: String) {
    require(PROVIDER_ID.matches(provider)) { "Unknown provider" }
    require(key.isNotBlank()) { "Enter an API key" }
    editAuth(context) { it.put(provider, JSONObject().put("type", "api_key").put("key", key.trim())) }
  }

  /** Like `pi auth logout <provider>`: only the stored credential goes. */
  @Synchronized
  fun signOut(context: Context, provider: String) {
    editAuth(context) { it.remove(provider) }
  }

  private fun editAuth(context: Context, change: (JSONObject) -> Unit) {
    val file = agentFile(context, "auth.json")
    val auth = if (file.isFile) JSONObject(file.readText()) else JSONObject()
    change(auth)
    writePrivate(file, auth.toString(2) + "\n")
  }

  private fun agentFile(context: Context, name: String) = File(GuestRuntime(context).rootfs, "$AGENT_DIR/$name")

  /** Pi keeps its directory and files readable by their owner only; auth.json holds secrets. */
  private fun writePrivate(file: File, text: String) {
    val dir = file.parentFile ?: return
    dir.mkdirs()
    runCatching { Files.setPosixFilePermissions(dir.toPath(), PosixFilePermissions.fromString("rwx------")) }
    val temp = File(dir, "${file.name}.tmp")
    temp.writeText(text)
    runCatching { Files.setPosixFilePermissions(temp.toPath(), PosixFilePermissions.fromString("rw-------")) }
    if (!temp.renameTo(file)) {
      temp.delete()
      error("Could not save ${file.name}")
    }
  }
}
