package expo.modules.t3localserver

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet

/**
 * An agent CLI in the Linux environment, installed with npm so T3's provider finds it on PATH.
 * [installVersion] is what Install puts on; Update always takes the newest release.
 */
open class NpmTool(
  val title: String,
  private val packageName: String,
  private val installVersion: String = "latest",
) {
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
  protected fun update(change: (State) -> State) {
    val next = change(state)
    if (next == state) return
    state = next
    listeners.forEach { it(next) }
  }

  private fun packageJson(guest: GuestRuntime) = File(guest.rootfs, "opt/node/lib/node_modules/$packageName/package.json")

  fun refresh(context: Context): State {
    val manifest = packageJson(GuestRuntime(context))
    val version = runCatching { JSONObject(manifest.readText()).optString("version") }.getOrNull()?.ifEmpty { null }
    update { it.copy(installed = manifest.isFile, version = version) }
    return state
  }

  /** Each of these blocks until npm is done. */
  fun install(context: Context) = npm(context, "Installing", listOf("npm", "install", "-g", "$packageName@$installVersion"))

  fun upgrade(context: Context) = npm(context, "Updating", listOf("npm", "install", "-g", "$packageName@latest"))

  fun remove(context: Context) = npm(context, "Removing", listOf("npm", "uninstall", "-g", packageName))

  /** Runs after every install, update or removal, once [state] is current. */
  protected open fun changed(context: Context) = Unit

  private fun npm(context: Context, label: String, command: List<String>) {
    synchronized(this) {
      if (state.busy != null) return
      update { it.copy(busy = label, detail = null, error = null) }
    }
    val result = GitSetup(GuestRuntime(context)).run(command, timeoutSeconds = 900) { line ->
      line.trim().takeIf { it.isNotEmpty() }?.let { detail -> update { it.copy(detail = detail.take(80)) } }
    }
    val error = if (result.exitCode == 0) null else "$label $title failed: ${result.output.lines().lastOrNull { it.isNotBlank() } ?: "exit ${result.exitCode}"}"
    update { it.copy(busy = null, detail = null, error = error) }
    refresh(context)
    changed(context)
  }
}

/**
 * Install puts on the release tested on phones; Update takes the newest. Its sign-in and settings
 * in ~/.claude stay when it is removed.
 */
object ClaudeCode : NpmTool("Claude Code", "@anthropic-ai/claude-code", "2.1.319")

/** Agent CLIs the app installs in Linux, by the id the app uses for them. */
internal val AGENT_TOOLS: Map<String, NpmTool> = mapOf("opencode" to OpenCode, "claude" to ClaudeCode)

/** Reset Linux removes installed agents with the rest of Linux; this puts them back afterwards. */
internal object AgentReinstall {
  private fun file(guest: GuestRuntime) = File(guest.root, "reinstall-agents")

  /** Call before Linux is removed. */
  fun remember(context: Context) {
    val installed = AGENT_TOOLS.filterValues { it.refresh(context).installed }.keys
    file(GuestRuntime(context)).writeText(installed.joinToString("\n"))
  }

  /** Call once a fresh Linux is set up. A failed install shows on that agent's section. */
  fun run(context: Context, report: (String) -> Unit) {
    val list = file(GuestRuntime(context))
    val ids = list.takeIf { it.isFile }?.readLines()?.filter { it.isNotBlank() }.orEmpty()
    for (id in ids) {
      val tool = AGENT_TOOLS[id] ?: continue
      report("Installing ${tool.title}")
      tool.install(context)
    }
    list.delete()
  }
}
