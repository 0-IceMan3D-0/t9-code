package expo.modules.t3localserver

import android.content.Context
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

data class TermuxStatus(val state: String, val detail: String = "", val progress: Double = 0.0)

interface TermuxListener {
  fun onStatus()
  fun onOutput(id: Int, data: String)
  fun onExit(id: Int)
}

/** Process-wide so sessions outlive the screen and the React context. The service keeps the process. */
object TermuxSessions {
  private val sessions = ConcurrentHashMap<Int, ShellSession>()
  private val listeners = CopyOnWriteArrayList<TermuxListener>()
  private val nextId = AtomicInteger(1)

  @Volatile
  private var installing: TermuxStatus? = null

  @Volatile
  private var failure: String? = null

  val count get() = sessions.size
  val active get() = sessions.isNotEmpty() || installing != null

  fun ids() = sessions.keys.sorted()

  fun addListener(listener: TermuxListener) = listeners.add(listener)

  fun removeListener(listener: TermuxListener) = listeners.remove(listener)

  fun status(context: Context): TermuxStatus {
    installing?.let { return it }
    failure?.let { return TermuxStatus("failed", it) }
    return TermuxStatus(if (TermuxRuntime(context).isInstalled) "ready" else "notInstalled")
  }

  fun install(context: Context) {
    val app = context.applicationContext
    if (installing != null) return
    failure = null
    installing = TermuxStatus("installing", "Preparing")
    changed(app)
    thread(name = "t3-termux-install") {
      try {
        TermuxInstaller(TermuxRuntime(app)) { detail, progress ->
          installing = TermuxStatus("installing", detail, progress)
          listeners.forEach { it.onStatus() }
        }.install()
      } catch (error: Exception) {
        failure = error.message ?: error.toString()
      }
      installing = null
      changed(app)
    }
  }

  fun reset(context: Context) {
    val app = context.applicationContext
    closeAll()
    RuntimeInstaller.removeTree(TermuxRuntime(app).base)
    failure = null
    changed(app)
  }

  fun create(context: Context, cols: Int, rows: Int): Int {
    val app = context.applicationContext
    val termux = TermuxRuntime(app)
    val id = nextId.getAndIncrement()
    val infoPath = "${TermuxRuntime.PREFIX}/tmp/.t3-session-$id"
    sessions[id] = ShellSession(
      termux.process(ShellSession.scriptCommand(cols, rows, infoPath, "login")),
      termux.guestFile(infoPath),
      { tty, nextCols, nextRows ->
        termux.process(listOf("stty", "-F", tty, "rows", "$nextRows", "cols", "$nextCols"))
      },
      { data -> listeners.forEach { it.onOutput(id, data) } },
      {
        sessions.remove(id)
        listeners.forEach { it.onExit(id) }
        changed(app)
      },
    )
    changed(app)
    return id
  }

  fun get(id: Int) = sessions[id]

  fun closeAll() = sessions.values.forEach { it.close() }

  private fun changed(context: Context) {
    listeners.forEach { it.onStatus() }
    LocalServerService.sessionsChanged(context)
  }
}
