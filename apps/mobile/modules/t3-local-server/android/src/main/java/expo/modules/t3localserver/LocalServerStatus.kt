package expo.modules.t3localserver

import android.content.Context
import java.util.concurrent.CopyOnWriteArrayList

enum class LocalServerState(val id: String) {
  NOT_INSTALLED("notInstalled"),
  INSTALLING("installing"),
  STOPPED("stopped"),
  STARTING("starting"),
  RUNNING("running"),
  FAILED("failed"),
}

data class LocalServerStatus(
  val state: LocalServerState,
  val detail: String = "",
  val progress: Double = 0.0,
)

/** The service publishes here, and the module reads it, because they share one process. */
object LocalServerStatusStore {
  private val listeners = CopyOnWriteArrayList<(LocalServerStatus) -> Unit>()

  @Volatile
  var current: LocalServerStatus? = null
    private set

  /** Held in memory only. The pairing token never reaches the log or disk from here. */
  @Volatile
  var pairingUrl: String? = null

  fun publish(status: LocalServerStatus) {
    current = status
    listeners.forEach { it(status) }
  }

  /** The published state, or what the files say before the service has published anything. */
  fun resolve(context: Context): LocalServerStatus {
    val installed = GuestRuntime(context).isInstalled
    return current?.takeUnless { it.state == LocalServerState.STOPPED && !installed }
      ?: LocalServerStatus(if (installed) LocalServerState.STOPPED else LocalServerState.NOT_INSTALLED)
  }

  fun addListener(listener: (LocalServerStatus) -> Unit) = listeners.add(listener)

  fun removeListener(listener: (LocalServerStatus) -> Unit) = listeners.remove(listener)
}
