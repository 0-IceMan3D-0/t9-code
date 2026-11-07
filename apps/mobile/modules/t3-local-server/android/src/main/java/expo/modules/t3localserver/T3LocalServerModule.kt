package expo.modules.t3localserver

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.TimeUnit

private const val STATUS_EVENT = "onStatus"

class T3LocalServerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val guest get() = GuestRuntime(context)
  private val options get() = LocalServerOptions(context)
  private var login: ClaudeLogin? = null
  private val statusListener: (LocalServerStatus) -> Unit = { sendEvent(STATUS_EVENT, snapshot(it)) }

  private fun resolvedStatus() = LocalServerStatusStore.current?.takeUnless {
    it.state == LocalServerState.STOPPED && !guest.isInstalled
  } ?: LocalServerStatus(if (guest.isInstalled) LocalServerState.STOPPED else LocalServerState.NOT_INSTALLED)

  private fun snapshot(status: LocalServerStatus = resolvedStatus()) = mapOf(
    "state" to status.state.id,
    "detail" to status.detail,
    "progress" to status.progress,
    "port" to LocalServerService.PORT,
    "startAtBoot" to options.startAtBoot,
    "sharedStorage" to options.sharedStorage,
    "sharedStorageGranted" to storageGranted(),
  )

  private fun storageGranted() =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Environment.isExternalStorageManager()
    } else {
      appContext.permissions?.hasGrantedPermissions(Manifest.permission.WRITE_EXTERNAL_STORAGE) == true
    }

  private fun requireStopped() {
    val state = LocalServerStatusStore.current?.state
    if (state == LocalServerState.RUNNING || state == LocalServerState.STARTING || state == LocalServerState.INSTALLING) {
      throw CodedException("ERR_SERVER_RUNNING", "Stop the server first", null)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("T3LocalServer")
    Events(STATUS_EVENT)

    OnCreate { LocalServerStatusStore.addListener(statusListener) }
    OnDestroy { LocalServerStatusStore.removeListener(statusListener) }

    Function("getStatus") { snapshot() }
    Function("start") { LocalServerService.start(context) }
    Function("stop") { LocalServerService.stop(context) }
    Function("takePairingUrl") {
      LocalServerStatusStore.pairingUrl.also { LocalServerStatusStore.pairingUrl = null }
    }
    Function("setStartAtBoot") { value: Boolean -> options.startAtBoot = value }
    Function("setSharedStorage") { value: Boolean -> options.sharedStorage = value }

    AsyncFunction("readLog") {
      listOf("install.log", "server.log").joinToString("\n") { name ->
        File(guest.root, name).takeIf { it.isFile }?.readLines()?.takeLast(120)?.joinToString("\n").orEmpty()
      }.trim()
    }

    AsyncFunction("reset") {
      requireStopped()
      RuntimeInstaller.removeTree(guest.root)
      LocalServerStatusStore.publish(LocalServerStatus(LocalServerState.NOT_INSTALLED))
    }

    AsyncFunction("requestStorageAccess") { promise: Promise ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        context.startActivity(
          Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        promise.resolve(null)
      } else {
        Permissions.askForPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          Manifest.permission.WRITE_EXTERNAL_STORAGE,
        )
      }
    }

    AsyncFunction("claudeLoggedIn") {
      val process = guest.process(listOf("claude", "auth", "status")).start()
      val output = process.inputStream.bufferedReader().readText()
      process.waitFor()
      output.contains("\"loggedIn\": true")
    }

    AsyncFunction("startClaudeLogin") {
      login?.cancel()
      val session = ClaudeLogin(guest)
      login = session
      session.url.get(60, TimeUnit.SECONDS)
    }

    AsyncFunction("submitClaudeCode") { code: String ->
      val session = login ?: throw CodedException("ERR_NO_LOGIN", "Start the login first", null)
      session.submitCode(code)
      session.finished.get(60, TimeUnit.SECONDS)
    }

    AsyncFunction("waitForClaudeLogin") {
      val session = login ?: throw CodedException("ERR_NO_LOGIN", "Start the login first", null)
      session.finished.get(300, TimeUnit.SECONDS)
    }

    Function("cancelClaudeLogin") {
      login?.cancel()
      login = null
    }
  }
}
