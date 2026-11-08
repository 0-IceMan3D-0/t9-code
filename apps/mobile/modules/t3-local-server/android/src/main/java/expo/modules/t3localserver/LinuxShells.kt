package expo.modules.t3localserver

import android.content.Context
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet

/**
 * The Linux shell screen's sessions. They outlive the screen and a JS reload, and end when their
 * shell exits or the person closes the tab, which kills everything started in it.
 */
object LinuxShells {
  const val MAX_SESSIONS = 8

  interface Listener {
    fun onOutput(id: String, data: String)
    fun onExit(id: String)
  }

  private val sessions = LinkedHashMap<String, ShellSession>()
  private val listeners = CopyOnWriteArraySet<Listener>()
  private var nextId = 1

  fun addListener(listener: Listener) = listeners.add(listener)

  fun removeListener(listener: Listener) = listeners.remove(listener)

  @Synchronized
  fun ids() = sessions.filterValues { it.isAlive }.keys.toList()

  @Synchronized
  fun get(id: String) = sessions[id]?.takeIf { it.isAlive }

  @Synchronized
  fun open(context: Context, cols: Int, rows: Int): String {
    if (sessions.values.count { it.isAlive } >= MAX_SESSIONS) {
      throw IllegalStateException("Close a tab first. Up to $MAX_SESSIONS shells can be open.")
    }
    val id = "${nextId++}"
    val guest = GuestRuntime(context)
    val infoPath = "/tmp/.t3-shell-$id"
    guest.nameGroups()
    sessions[id] = ShellSession(
      guest.process(ShellSession.scriptCommand(cols, rows, infoPath, "bash -l")),
      File(guest.rootfs, infoPath),
      { tty, nextCols, nextRows -> guest.process(listOf("stty", "-F", tty, "rows", "$nextRows", "cols", "$nextCols")) },
      { data -> listeners.forEach { it.onOutput(id, data) } },
      {
        synchronized(this) { sessions.remove(id) }
        listeners.forEach { it.onExit(id) }
      },
    )
    return id
  }

  fun close(id: String) {
    val session = synchronized(this) { sessions[id] } ?: return
    if (session.isAlive) session.close()
  }

  fun closeAll() {
    val all = synchronized(this) { sessions.values.toList() }
    all.filter { it.isAlive }.forEach { it.close() }
  }

  /** What each tab is doing: the newest program started from the shell, and the last title set. */
  fun describe(): List<Map<String, Any?>> {
    val entries = synchronized(this) { sessions.filterValues { it.isAlive }.toList() }
    return entries.map { (id, session) ->
      val pid = session.shellPid()
      val children = pid?.let { shell -> ProcessTree.descendants(shell).filter { it.ppid == shell } }.orEmpty()
      val command = children.maxByOrNull { it.pid }?.let { ProcessTree.commandLine(it.pid) }
        ?.joinToString(" ")?.ifEmpty { null }
      mapOf("id" to id, "command" to command, "title" to session.title, "busy" to children.isNotEmpty())
    }
  }
}
