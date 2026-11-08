package expo.modules.t3localserver

import android.annotation.SuppressLint
import android.app.Activity
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.Toast

/** The "T3² server" Quick Settings tile: shows the built-in server's state and starts or stops it. */
class ServerTileService : TileService() {
  private val main = Handler(Looper.getMainLooper())
  private val listener: (LocalServerStatus) -> Unit = { main.post { update() } }

  override fun onStartListening() {
    LocalServerStatusStore.addListener(listener)
    update()
  }

  override fun onStopListening() {
    LocalServerStatusStore.removeListener(listener)
  }

  override fun onClick() {
    if (isLocked) unlockAndRun { toggle() } else toggle()
  }

  private fun toggle() {
    if (LinuxMaintenance.busy) return
    when (LocalServerStatusStore.resolve(this).state) {
      LocalServerState.NOT_INSTALLED -> open(ThisPhoneActivity.intent(this))
      LocalServerState.RUNNING, LocalServerState.STARTING, LocalServerState.INSTALLING ->
        runOrOpen(ServerSwitchActivity.ACTION_STOP) { LocalServerService.stop(this) }
      LocalServerState.STOPPED, LocalServerState.FAILED ->
        runOrOpen(ServerSwitchActivity.ACTION_START) { LocalServerService.start(this) }
    }
  }

  // Android 12+ may refuse a foreground service start from the tile's process; an activity may
  // always start one, so the tile falls back to the invisible switch activity.
  private fun runOrOpen(action: String, start: () -> Unit) {
    try {
      start()
    } catch (_: IllegalStateException) {
      open(ServerSwitchActivity.intent(this, action))
    }
  }

  @SuppressLint("StartActivityAndCollapseDeprecated")
  private fun open(intent: Intent) {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
    } else {
      @Suppress("DEPRECATION")
      startActivityAndCollapse(intent)
    }
  }

  private fun update() {
    val tile = qsTile ?: return
    val status = LocalServerStatusStore.resolve(this)
    val (state, subtitle) = when {
      LinuxMaintenance.busy -> Tile.STATE_UNAVAILABLE to "Busy"
      else -> when (status.state) {
        LocalServerState.NOT_INSTALLED -> Tile.STATE_INACTIVE to "Not set up"
        LocalServerState.INSTALLING -> Tile.STATE_ACTIVE to "Setting up…"
        LocalServerState.STARTING -> Tile.STATE_ACTIVE to "Starting…"
        LocalServerState.RUNNING -> Tile.STATE_ACTIVE to "Running"
        LocalServerState.STOPPED -> Tile.STATE_INACTIVE to "Stopped"
        LocalServerState.FAILED -> Tile.STATE_INACTIVE to "Failed"
      }
    }
    tile.state = state
    tile.icon = Icon.createWithResource(this, R.drawable.t3_tile_server)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) tile.subtitle = subtitle
    tile.contentDescription = "T3² server, $subtitle"
    tile.updateTile()
  }

  companion object {
    @Volatile
    private var watching = false

    /** Redraws the tile and relabels the server shortcut whenever the server's state changes. */
    fun watch(context: Context) {
      if (watching) return
      watching = true
      val app = context.applicationContext
      val component = ComponentName(app, ServerTileService::class.java)
      val refresh = {
        runCatching { requestListeningState(app, component) }
        ServerShortcut.update(app)
      }
      LocalServerStatusStore.addListener { refresh() }
      LinuxMaintenance.addListener { refresh() }
    }
  }
}

/** Starts or stops the server from a tile or shortcut without showing the app. Not exported. */
class ServerSwitchActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val state = LocalServerStatusStore.resolve(this).state
    val running = state == LocalServerState.RUNNING ||
      state == LocalServerState.STARTING ||
      state == LocalServerState.INSTALLING
    val message = when {
      LinuxMaintenance.busy -> "Wait for the backup or restore to finish"
      state == LocalServerState.NOT_INSTALLED -> {
        startActivity(ThisPhoneActivity.intent(this))
        null
      }
      intent?.action == ACTION_STOP -> if (running) "Stopping the built-in server".also { LocalServerService.stop(this) } else "The built-in server is not running"
      running -> "The built-in server is already running"
      else -> "Starting the built-in server".also { LocalServerService.start(this) }
    }
    message?.let { Toast.makeText(applicationContext, it, Toast.LENGTH_SHORT).show() }
    finish()
  }

  companion object {
    const val ACTION_START = "expo.modules.t3localserver.action.START_SERVER"
    const val ACTION_STOP = "expo.modules.t3localserver.action.STOP_SERVER"

    fun intent(context: Context, action: String): Intent =
      Intent(context, ServerSwitchActivity::class.java).setAction(action)
  }
}

/**
 * Opens Settings > This phone. Exported for the tile's long-press (QS_TILE_PREFERENCES), which the
 * system sends; it only opens a screen of the app.
 */
class ThisPhoneActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    startActivity(appIntent(this))
    finish()
  }

  companion object {
    fun intent(context: Context): Intent = Intent(context, ThisPhoneActivity::class.java)

    /** The app's own deep link to This phone, on the activity behind the launcher alias. */
    fun appIntent(context: Context): Intent {
      val packageManager = context.packageManager
      val launch = packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
      launch.resolveActivityInfo(packageManager, 0)?.let {
        launch.setClassName(context.packageName, it.targetActivity ?: it.name)
      }
      LocalServerOptions(context).appScheme?.let {
        launch.setAction(Intent.ACTION_VIEW).setData(Uri.parse("$it://settings/this-phone"))
      }
      return launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
  }
}

/**
 * Keeps the launcher's "Start server" / "Stop server" shortcut in step with the server, also when
 * the tile started it and no screen of the app ever ran. The app publishes the shortcut
 * (appShortcuts.ts, SERVER_SHORTCUT_ID); this only relabels one that exists.
 */
object ServerShortcut {
  private const val ID = "server"

  fun update(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val state = LocalServerStatusStore.resolve(context).state
    if (state == LocalServerState.NOT_INSTALLED) return
    val stopped = state == LocalServerState.STOPPED || state == LocalServerState.FAILED
    val action = if (stopped) ServerSwitchActivity.ACTION_START else ServerSwitchActivity.ACTION_STOP
    val manager = context.getSystemService(ShortcutManager::class.java) ?: return
    val current = manager.dynamicShortcuts.firstOrNull { it.id == ID } ?: return
    // Android rate-limits shortcut updates from the background, so only real changes are sent.
    if (current.intent?.action == action) return
    val label = if (stopped) "Start server" else "Stop server"
    runCatching {
      manager.updateShortcuts(
        listOf(
          ShortcutInfo.Builder(context, ID)
            .setShortLabel(label)
            .setLongLabel(label)
            .setIntent(ServerSwitchActivity.intent(context, action))
            .build(),
        ),
      )
    }
  }
}
