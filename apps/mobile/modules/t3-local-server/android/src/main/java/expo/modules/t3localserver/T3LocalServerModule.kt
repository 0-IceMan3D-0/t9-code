package expo.modules.t3localserver

import android.Manifest
import android.app.Activity
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
import kotlin.concurrent.thread

private const val STATUS_EVENT = "onStatus"
private const val SHELL_OUTPUT_EVENT = "onShellOutput"
private const val SHELL_EXIT_EVENT = "onShellExit"
private const val DOWNLOAD_PROGRESS_EVENT = "onDownloadProgress"
private const val USB_DEVICES_EVENT = "onUsbDevices"
private const val MAINTENANCE_EVENT = "onMaintenance"
private const val DEV_SERVERS_EVENT = "onDevServers"
private const val CREATE_BACKUP_REQUEST = 7461
private const val OPEN_BACKUP_REQUEST = 7462

private var appOpenHandled = false

class T3LocalServerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val guest get() = GuestRuntime(context)
  private val options get() = LocalServerOptions(context)
  private var login: ClaudeLogin? = null
  private var shell: ShellSession? = null
  private val statusListener: (LocalServerStatus) -> Unit = { sendEvent(STATUS_EVENT, snapshot(it)) }
  private val usbListener: () -> Unit = { sendEvent(USB_DEVICES_EVENT, mapOf("devices" to usbDevices())) }
  private val maintenanceListener: (Map<String, Any?>) -> Unit = { sendEvent(MAINTENANCE_EVENT, it) }
  private val devServersListener: (List<DevServers.Server>) -> Unit = { servers ->
    sendEvent(DEV_SERVERS_EVENT, mapOf("servers" to servers.map { it.toMap() }))
  }
  private var pendingDocument: Pair<Int, (Uri?) -> Unit>? = null

  private fun pickDocument(intent: Intent, requestCode: Int, promise: Promise, then: (Uri?) -> Unit) {
    val activity = appContext.currentActivity
      ?: return promise.reject(CodedException("ERR_NO_ACTIVITY", "Open the app first", null))
    pendingDocument = requestCode to then
    try {
      activity.startActivityForResult(intent, requestCode)
    } catch (error: Exception) {
      pendingDocument = null
      promise.reject(CodedException("ERR_PICKER", "Android has no file picker for this", error))
    }
  }

  private fun runMaintenance(operation: String, promise: Promise, work: (MaintenanceProgress) -> String) {
    val app = context
    try {
      LinuxMaintenance.run(app, operation, { org.json.JSONObject(work(it)) }) { result ->
        result.fold(
          { promise.resolve(it.toString()) },
          {
            if (it is MaintenanceCancelled) promise.resolve(null)
            else promise.reject(CodedException("ERR_MAINTENANCE", it.message ?: it.toString(), it))
          },
        )
      }
    } catch (error: IllegalStateException) {
      promise.reject(CodedException("ERR_BUSY", error.message, error))
    }
  }

  private fun closeShell() {
    shell?.takeIf { it.isAlive }?.close()
    shell = null
  }

  private fun usbDevices() = UsbBridge.devices().map {
    mapOf(
      "name" to it.usb.deviceName,
      "vendorId" to it.usb.vendorId,
      "productId" to it.usb.productId,
      "label" to listOfNotNull(it.usb.manufacturerName, it.usb.productName).joinToString(" ").ifBlank { "USB device" },
      "allowed" to it.allowed,
    )
  }

  // Frees the space of the Termux environment that earlier builds could install.
  private fun removeRetiredTermux() {
    val retired = File(appContext.reactContext?.filesDir ?: return, "termux")
    if (retired.exists()) thread(name = "t3-remove-retired") { RuntimeInstaller.removeTree(retired) }
  }

  // Once per app process: a JS reload or a second React context must not undo a manual Stop.
  private fun startOnAppOpen(app: Context) {
    if (appOpenHandled) return
    appOpenHandled = true
    val idle = LocalServerStatusStore.current?.state.let {
      it == null || it == LocalServerState.STOPPED || it == LocalServerState.FAILED
    }
    if (idle && LocalServerOptions(app).startOnAppOpen && GuestRuntime(app).isInstalled) {
      runCatching { LocalServerService.start(app) }
        .onFailure { LocalServerStatusStore.publish(LocalServerStatus(LocalServerState.FAILED, "Could not start: ${it.message}")) }
    }
  }

  private fun openLinuxShell(cols: Int, rows: Int): ShellSession {
    val infoPath = "/tmp/.t3-shell-tty"
    guest.nameGroups()
    return ShellSession(
      guest.process(ShellSession.scriptCommand(cols, rows, infoPath, "bash -l")),
      File(guest.rootfs, infoPath),
      { tty, nextCols, nextRows -> guest.process(listOf("stty", "-F", tty, "rows", "$nextRows", "cols", "$nextCols")) },
      { sendEvent(SHELL_OUTPUT_EVENT, mapOf("data" to it)) },
      { sendEvent(SHELL_EXIT_EVENT, emptyMap<String, Any>()) },
    )
  }

  private fun resolvedStatus() = LocalServerStatusStore.current?.takeUnless {
    it.state == LocalServerState.STOPPED && !guest.isInstalled
  } ?: LocalServerStatus(if (guest.isInstalled) LocalServerState.STOPPED else LocalServerState.NOT_INSTALLED)

  private fun snapshot(status: LocalServerStatus = resolvedStatus()) = mapOf(
    "state" to status.state.id,
    "detail" to status.detail,
    "progress" to status.progress,
    "port" to LocalServerService.PORT,
    "startOnAppOpen" to options.startOnAppOpen,
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
    if (LinuxMaintenance.busy) throw CodedException("ERR_BUSY", "Wait for the backup or restore to finish", null)
    val state = LocalServerStatusStore.current?.state
    if (state == LocalServerState.RUNNING || state == LocalServerState.STARTING || state == LocalServerState.INSTALLING) {
      throw CodedException("ERR_SERVER_RUNNING", "Stop the server first", null)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("T3LocalServer")
    Events(
      STATUS_EVENT,
      SHELL_OUTPUT_EVENT,
      SHELL_EXIT_EVENT,
      DOWNLOAD_PROGRESS_EVENT,
      USB_DEVICES_EVENT,
      MAINTENANCE_EVENT,
      DEV_SERVERS_EVENT,
    )

    OnCreate {
      LocalServerStatusStore.addListener(statusListener)
      LinuxMaintenance.addListener(maintenanceListener)
      appContext.reactContext?.let {
        // Finishes or undoes a restore the app was killed in the middle of.
        if (!LinuxMaintenance.busy) runCatching { MaintenancePaths(it).recover() }
        UsbBridge.start(it)
        startOnAppOpen(it)
      }
      UsbBridge.addListener(usbListener)
      DevServers.addListener(devServersListener)
      removeRetiredTermux()
    }
    OnDestroy {
      LocalServerStatusStore.removeListener(statusListener)
      LinuxMaintenance.removeListener(maintenanceListener)
      UsbBridge.removeListener(usbListener)
      DevServers.removeListener(devServersListener)
    }

    OnActivityResult { _, payload ->
      val (code, then) = pendingDocument ?: return@OnActivityResult
      if (payload.requestCode != code) return@OnActivityResult
      pendingDocument = null
      then(payload.data?.data?.takeIf { payload.resultCode == Activity.RESULT_OK })
    }

    Function("getStatus") { snapshot() }
    Function("listUsbDevices") { usbDevices() }
    Function("listDevServers") { DevServers.current.map { it.toMap() } }
    Function("allowUsbDevice") { name: String -> UsbBridge.requestAccess(name) }
    Function("start") {
      if (LinuxMaintenance.busy) throw CodedException("ERR_BUSY", "Wait for the backup or restore to finish", null)
      LocalServerService.start(context)
    }
    Function("stop") { LocalServerService.stop(context) }
    Function("takePairingUrl") {
      LocalServerStatusStore.pairingUrl.also { LocalServerStatusStore.pairingUrl = null }
    }
    Function("setStartOnAppOpen") { value: Boolean -> options.startOnAppOpen = value }
    Function("setSharedStorage") { value: Boolean -> options.sharedStorage = value }

    Function("getBatteryState") {
      mapOf(
        "optimized" to BatteryOptimization.isOptimized(context),
        "hintDismissed" to options.batteryHintDismissed,
      )
    }
    Function("openBatterySettings") { BatteryOptimization.openSettings(appContext.currentActivity ?: context) }
    Function("dismissBatteryHint") { options.batteryHintDismissed = true }

    AsyncFunction("readLog") {
      listOf("install.log", "server.log").joinToString("\n") { name ->
        File(guest.root, name).takeIf { it.isFile }?.readLines()?.takeLast(120)?.joinToString("\n").orEmpty()
      }.trim()
    }

    AsyncFunction("sampleHealth") { ServerHealth.sample(context) }
    AsyncFunction("measureStorage") { ServerHealth.storage(context) }

    Function("getMaintenance") { LinuxMaintenance.last }
    Function("clearMaintenance") { LinuxMaintenance.clear() }
    Function("cancelMaintenance") { LinuxMaintenance.cancel() }

    AsyncFunction("backupLinux") { destination: String, promise: Promise ->
      requireStopped()
      val app = context
      val fileName = LinuxBackup.fileName()
      val begin = { sink: BackupSink ->
        runMaintenance("backup", promise) { LinuxBackup.backup(app, GuestRuntime(app), sink, it).toString() }
      }
      if (destination == "downloads") {
        begin(DownloadsSink(app, fileName))
      } else {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
          .addCategory(Intent.CATEGORY_OPENABLE)
          .setType("application/gzip")
          .putExtra(Intent.EXTRA_TITLE, fileName)
        pickDocument(intent, CREATE_BACKUP_REQUEST, promise) { uri ->
          if (uri == null) promise.resolve(null) else begin(DocumentSink(app, uri))
        }
      }
    }

    AsyncFunction("pickBackup") { promise: Promise ->
      val app = context
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
      pickDocument(intent, OPEN_BACKUP_REQUEST, promise) { uri ->
        if (uri == null) {
          promise.resolve(null)
        } else {
          thread(name = "t3-read-backup") {
            runCatching { LinuxBackup.readManifest(app, uri).put("uri", uri.toString()).toString() }.fold(
              { promise.resolve(it) },
              { promise.reject(CodedException("ERR_BACKUP", it.message ?: it.toString(), it)) },
            )
          }
        }
      }
    }

    AsyncFunction("restoreLinux") { uri: String, promise: Promise ->
      requireStopped()
      closeShell()
      val app = context
      runMaintenance("restore", promise) {
        LinuxBackup.restore(app, GuestRuntime(app), Uri.parse(uri), it).toString().also {
          LocalServerStatusStore.publish(LocalServerStatus(LocalServerState.STOPPED))
        }
      }
    }

    AsyncFunction("resetLinux") {
      requireStopped()
      if (!guest.isInstalled) throw CodedException("ERR_NOT_INSTALLED", "Linux is not set up", null)
      closeShell()
      try {
        KeptFiles.moveAside(guest)
      } catch (error: Exception) {
        KeptFiles.restore(guest)
        throw error
      }
      File(guest.root, GuestRuntime.INSTALLED_MARKER).delete()
      RuntimeInstaller.removeTree(guest.rootfs)
      LocalServerService.start(context)
    }

    AsyncFunction("reset") {
      requireStopped()
      closeShell()
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

    AsyncFunction("openShell") { cols: Int, rows: Int ->
      val current = shell?.takeIf { it.isAlive } ?: openLinuxShell(cols, rows).also { shell = it }
      current.history()
    }
    Function("writeShell") { data: String -> shell?.write(data) }
    Function("resizeShell") { cols: Int, rows: Int -> shell?.resize(cols, rows) }

    AsyncFunction("saveToDownloads") { id: String, url: String, fileName: String, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        promise.reject(CodedException("ERR_UNSUPPORTED", "Needs Android 10 or newer", null))
        return@AsyncFunction
      }
      val app = context
      thread(name = "t3-download") {
        runCatching {
          PublicDownloads.save(app, url, fileName) { written, total ->
            sendEvent(DOWNLOAD_PROGRESS_EVENT, mapOf("id" to id, "written" to written, "total" to total))
          }
        }.fold(
          { promise.resolve(it) },
          { promise.reject(CodedException("ERR_DOWNLOAD", it.message ?: it.toString(), it)) },
        )
      }
    }

    Function("cancelClaudeLogin") {
      login?.cancel()
      login = null
    }
  }
}
