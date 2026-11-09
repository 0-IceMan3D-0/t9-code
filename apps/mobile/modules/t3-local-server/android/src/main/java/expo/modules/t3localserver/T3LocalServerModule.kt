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
private const val GIT_SETUP_EVENT = "onGitSetup"
private const val OLLAMA_EVENT = "onOllama"
private const val CREATE_BACKUP_REQUEST = 7461
private const val OPEN_BACKUP_REQUEST = 7462

private var appOpenHandled = false

class T3LocalServerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val guest get() = GuestRuntime(context)
  private val options get() = LocalServerOptions(context)
  private var login: ClaudeLogin? = null
  private val shellListener = object : LinuxShells.Listener {
    override fun onOutput(id: String, data: String) = sendEvent(SHELL_OUTPUT_EVENT, mapOf("id" to id, "data" to data))

    override fun onExit(id: String) = sendEvent(SHELL_EXIT_EVENT, mapOf("id" to id))
  }
  private val statusListener: (LocalServerStatus) -> Unit = { sendEvent(STATUS_EVENT, snapshot(it)) }
  private val usbListener: () -> Unit = { sendEvent(USB_DEVICES_EVENT, mapOf("devices" to usbDevices())) }
  private val maintenanceListener: (Map<String, Any?>) -> Unit = { sendEvent(MAINTENANCE_EVENT, it) }
  private val ollamaListener: (Ollama.State) -> Unit = { sendEvent(OLLAMA_EVENT, it.toMap()) }
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

  /** Runs slow guest work off the module's queue, so the shell and other calls stay responsive. */
  private fun inBackground(name: String, promise: Promise, work: () -> Any?) {
    thread(name = name) {
      runCatching(work).fold(
        { promise.resolve(it.takeUnless { value -> value is Unit }) },
        {
          val code = if (it is GitSetup.KeyExists) "ERR_KEY_EXISTS" else "ERR_GIT_SETUP"
          promise.reject(it as? CodedException ?: CodedException(code, it.message ?: it.toString(), it))
        },
      )
    }
  }

  private fun files() = LocalFiles(context, guest)

  private fun gitSetup(): GitSetup {
    if (!guest.isInstalled) throw CodedException("ERR_NOT_INSTALLED", "Linux is not set up", null)
    if (LinuxMaintenance.busy) throw CodedException("ERR_BUSY", "Wait for the backup or restore to finish", null)
    return GitSetup(guest)
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

  private fun snapshot(status: LocalServerStatus = LocalServerStatusStore.resolve(context)) = mapOf(
    "state" to status.state.id,
    "detail" to status.detail,
    "progress" to status.progress,
    "port" to LocalServerService.PORT,
    "startOnAppOpen" to options.startOnAppOpen,
    "stopOnLeave" to options.stopOnLeave,
    "stopAfterMinutes" to options.stopAfterMinutes,
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
      GIT_SETUP_EVENT,
      OLLAMA_EVENT,
    )

    OnCreate {
      LocalServerStatusStore.addListener(statusListener)
      LinuxMaintenance.addListener(maintenanceListener)
      appContext.reactContext?.let {
        // Finishes or undoes a restore the app was killed in the middle of.
        if (!LinuxMaintenance.busy) runCatching { MaintenancePaths(it).recover() }
        UsbBridge.start(it)
        ServerTileService.watch(it)
        AutoStop.install(it)
        startOnAppOpen(it)
      }
      UsbBridge.addListener(usbListener)
      LinuxShells.addListener(shellListener)
      DevServers.addListener(devServersListener)
      Ollama.addListener(ollamaListener)
      removeRetiredTermux()
    }
    OnDestroy {
      LocalServerStatusStore.removeListener(statusListener)
      LinuxMaintenance.removeListener(maintenanceListener)
      UsbBridge.removeListener(usbListener)
      LinuxShells.removeListener(shellListener)
      DevServers.removeListener(devServersListener)
      Ollama.removeListener(ollamaListener)
      AutoStop.forgetThreads()
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
    Function("setStopOnLeave") { value: Boolean ->
      options.stopOnLeave = value
      AutoStop.optionChanged()
    }
    Function("setStopAfterMinutes") { minutes: Int ->
      options.stopAfterMinutes = minutes
      AutoStop.optionChanged()
    }
    Function("ollamaState") { Ollama.refresh(context).toMap() }
    Function("installOllama") { Ollama.install(context) }
    Function("uninstallOllama") { Ollama.uninstall(context) }
    Function("pullOllamaModel") { name: String -> Ollama.pull(name) }
    Function("deleteOllamaModel") { name: String -> Ollama.delete(name) }
    Function("reportThreadWork") { json: String -> AutoStop.reportThreads(json) }
    Function("setSharedStorage") { value: Boolean -> options.sharedStorage = value }
    Function("serverSwitchTarget") {
      mapOf(
        "className" to ServerSwitchActivity::class.java.name,
        "start" to ServerSwitchActivity.ACTION_START,
        "stop" to ServerSwitchActivity.ACTION_STOP,
      )
    }
    Function("setAppScheme") { scheme: String -> options.appScheme = scheme }

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
      LinuxShells.closeAll()
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
      LinuxShells.closeAll()
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
      LinuxShells.closeAll()
      RuntimeInstaller.removeTree(guest.root)
      LocalServerStatusStore.publish(LocalServerStatus(LocalServerState.NOT_INSTALLED))
    }

    // File explorer calls walk folders and copy files, so they run off the module's queue too.
    Function("filesStorageGranted") { files().storageGranted() }
    Function("filesUri") { volume: String, path: String -> files().fileUri(volume, path) }
    AsyncFunction("filesList") { volume: String, path: String, promise: Promise ->
      inBackground("t3-files", promise) { files().list(volume, path) }
    }
    AsyncFunction("filesStat") { volume: String, path: String, promise: Promise ->
      inBackground("t3-files", promise) { files().stat(volume, path) }
    }
    AsyncFunction("filesCreateDirectory") { volume: String, path: String, promise: Promise ->
      inBackground("t3-files", promise) { files().createDirectory(volume, path) }
    }
    AsyncFunction("filesCreateFile") { volume: String, path: String, promise: Promise ->
      inBackground("t3-files", promise) { files().createFile(volume, path) }
    }
    AsyncFunction("filesCopy") { fromVolume: String, from: String, toVolume: String, to: String, promise: Promise ->
      inBackground("t3-files", promise) { files().copy(fromVolume, from, toVolume, to) }
    }
    AsyncFunction("filesMove") { fromVolume: String, from: String, toVolume: String, to: String, promise: Promise ->
      inBackground("t3-files", promise) { files().move(fromVolume, from, toVolume, to) }
    }
    AsyncFunction("filesDelete") { volume: String, paths: List<String>, promise: Promise ->
      inBackground("t3-files", promise) { files().delete(volume, paths) }
    }
    AsyncFunction("filesReadText") { volume: String, path: String, maxBytes: Int, promise: Promise ->
      inBackground("t3-files", promise) { files().readText(volume, path, maxBytes) }
    }
    AsyncFunction("filesWriteText") { volume: String, path: String, contents: String, expectedModifiedAt: Double?, promise: Promise ->
      inBackground("t3-files", promise) { files().writeText(volume, path, contents, expectedModifiedAt) }
    }
    AsyncFunction("filesReadBase64") { volume: String, path: String, offset: Double, length: Int, promise: Promise ->
      inBackground("t3-files", promise) { files().readBase64(volume, path, offset, length) }
    }
    AsyncFunction("filesImport") { volume: String, path: String, sourceUri: String, promise: Promise ->
      inBackground("t3-files", promise) { files().importFile(volume, path, sourceUri) }
    }
    AsyncFunction("filesSaveToDownloads") { volume: String, path: String, promise: Promise ->
      inBackground("t3-files", promise) { files().saveToDownloads(volume, path) }
    }
    AsyncFunction("filesOpen") { volume: String, path: String, share: Boolean, promise: Promise ->
      inBackground("t3-files", promise) { files().open(volume, path, share) }
    }
    AsyncFunction("filesSearch") { volume: String, path: String, query: String, limit: Int, promise: Promise ->
      inBackground("t3-files", promise) { files().search(volume, path, query, limit) }
    }
    AsyncFunction("filesSize") { volume: String, path: String, promise: Promise ->
      inBackground("t3-files", promise) { files().size(volume, path) }
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

    // The login calls block for minutes, so they run off the module's queue: waitForClaudeLogin
    // would otherwise hold submitClaudeCode back until it timed out.
    AsyncFunction("claudeLoggedIn") { promise: Promise ->
      inBackground("t3-claude-status", promise) {
        val process = guest.process(listOf("claude", "auth", "status")).start()
        val output = process.inputStream.bufferedReader().readText()
        process.waitFor()
        output.contains("\"loggedIn\": true")
      }
    }

    AsyncFunction("startClaudeLogin") { promise: Promise ->
      login?.cancel()
      val session = ClaudeLogin(guest)
      login = session
      inBackground("t3-claude-login-url", promise) { session.url.get(60, TimeUnit.SECONDS) }
    }

    AsyncFunction("submitClaudeCode") { code: String, promise: Promise ->
      val session = login ?: throw CodedException("ERR_NO_LOGIN", "Start the login first", null)
      inBackground("t3-claude-login-code", promise) {
        session.submitCode(code)
        val exit = session.finished.get(60, TimeUnit.SECONDS)
        session.failure?.let { throw CodedException("ERR_CLAUDE_LOGIN", it, null) }
        exit
      }
    }

    AsyncFunction("waitForClaudeLogin") { promise: Promise ->
      val session = login ?: throw CodedException("ERR_NO_LOGIN", "Start the login first", null)
      inBackground("t3-claude-login-wait", promise) { session.finished.get(300, TimeUnit.SECONDS) }
    }

    Function("listShells") { LinuxShells.ids() }
    AsyncFunction("describeShells") { LinuxShells.describe() }
    AsyncFunction("openShell") { cols: Int, rows: Int ->
      if (LinuxMaintenance.busy) throw CodedException("ERR_BUSY", "Wait for the backup or restore to finish", null)
      try {
        LinuxShells.open(context, cols, rows)
      } catch (error: IllegalStateException) {
        throw CodedException("ERR_TOO_MANY_SHELLS", error.message, error)
      }
    }
    AsyncFunction("shellHistory") { id: String -> LinuxShells.get(id)?.history() }
    AsyncFunction("closeShell") { id: String -> LinuxShells.close(id) }
    Function("writeShell") { id: String, data: String -> LinuxShells.get(id)?.write(data) }
    Function("resizeShell") { id: String, cols: Int, rows: Int -> LinuxShells.get(id)?.resize(cols, rows) }

    AsyncFunction("gitStatus") { promise: Promise ->
      val setup = gitSetup()
      inBackground("t3-git-status", promise) { setup.status().toString() }
    }
    AsyncFunction("setGitIdentity") { name: String, email: String, promise: Promise ->
      val setup = gitSetup()
      inBackground("t3-git-identity", promise) { setup.setIdentity(name, email) }
    }
    AsyncFunction("installGitTools") { promise: Promise ->
      val setup = gitSetup()
      inBackground("t3-git-install", promise) {
        val result = setup.installTools { stage, percent, detail ->
          sendEvent(GIT_SETUP_EVENT, mapOf("stage" to stage, "percent" to percent, "detail" to detail))
        }
        if (result.exitCode != 0) {
          throw IllegalStateException(result.output.lines().takeLast(6).joinToString("\n").ifBlank { "apt-get failed" })
        }
      }
    }
    AsyncFunction("createSshKey") { overwrite: Boolean, promise: Promise ->
      val setup = gitSetup()
      inBackground("t3-ssh-keygen", promise) { setup.createKey(overwrite) }
    }
    AsyncFunction("deleteSshKey") { gitSetup().deleteKey() }
    AsyncFunction("testGitHub") { promise: Promise ->
      val setup = gitSetup()
      inBackground("t3-ssh-test", promise) {
        setup.testGitHub().let { org.json.JSONObject().put("exitCode", it.exitCode).put("output", it.output).toString() }
      }
    }

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
