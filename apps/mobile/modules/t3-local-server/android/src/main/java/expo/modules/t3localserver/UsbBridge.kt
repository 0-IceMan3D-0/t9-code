package expo.modules.t3localserver

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Process
import android.system.Os
import android.util.Log
import java.io.File
import java.io.FileDescriptor
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread

/**
 * Lets the Linux environment use USB devices. Apps cannot open /dev/bus/usb, so this asks Android
 * for access, then hands usbfs fds to the guest over an abstract socket (see native/usb/t3usb.h).
 * It also keeps a fake sysfs and devfs tree of allowed devices in the rootfs for the preload library.
 */
object UsbBridge {
  private const val TAG = "T3UsbBridge"
  private const val ACTION_PERMISSION = "expo.modules.t3localserver.USB_PERMISSION"
  private const val PREFERENCES = "t3-usb"
  private const val ALLOWED_VENDORS = "allowedVendors"
  private const val ANSWER_SECONDS = 120L

  data class Device(val usb: UsbDevice, val bus: Int, val dev: Int, val allowed: Boolean)

  @Volatile
  private var app: Context? = null
  private val watchers = CopyOnWriteArrayList<LocalSocket>()
  private val answers = ConcurrentHashMap<String, CompletableFuture<Boolean>>()
  private val listeners = CopyOnWriteArraySet<() -> Unit>()
  private var published = emptySet<Pair<Int, Int>>()

  fun socketName(context: Context) = "${context.packageName}.usb"

  @Synchronized
  fun start(context: Context) {
    if (app != null) return
    val appContext = context.applicationContext
    app = appContext
    val events = IntentFilter().apply {
      addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
      addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
      addAction(ACTION_PERMISSION)
    }
    // Attach and detach come from the system; the permission answer is our own PendingIntent.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      appContext.registerReceiver(receiver, events, Context.RECEIVER_NOT_EXPORTED)
    } else {
      appContext.registerReceiver(receiver, events)
    }
    thread(name = "t3-usb-socket", isDaemon = true) { serve(socketName(appContext)) }
    refresh()
  }

  fun addListener(listener: () -> Unit) = listeners.add(listener)

  fun removeListener(listener: () -> Unit) = listeners.remove(listener)

  fun devices(): List<Device> {
    val manager = manager() ?: return emptyList()
    return manager.deviceList.values.mapNotNull { usb ->
      val (bus, dev) = address(usb) ?: return@mapNotNull null
      Device(usb, bus, dev, manager.hasPermission(usb))
    }.sortedWith(compareBy({ it.bus }, { it.dev }))
  }

  /** Shows Android's prompt. The answer arrives as a refresh, or completes the returned future. */
  fun requestAccess(usb: UsbDevice): CompletableFuture<Boolean> {
    val context = app ?: return CompletableFuture.completedFuture(false)
    val manager = manager() ?: return CompletableFuture.completedFuture(false)
    if (manager.hasPermission(usb)) return CompletableFuture.completedFuture(true)
    val answer = answers.computeIfAbsent(usb.deviceName) { CompletableFuture() }
    // The system adds the device and the answer to this intent, so it must stay mutable.
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    val intent = Intent(ACTION_PERMISSION).setPackage(context.packageName)
    manager.requestPermission(usb, PendingIntent.getBroadcast(context, usb.deviceId, intent, flags))
    return answer
  }

  fun requestAccess(deviceName: String) {
    devices().firstOrNull { it.usb.deviceName == deviceName }?.let { requestAccess(it.usb) }
  }

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val usb = intent.usbDevice()
      when (intent.action) {
        UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
          // A phone rebooting into fastboot comes back as a new device that needs a new answer.
          if (usb != null && usb.vendorId in allowedVendors()) requestAccess(usb)
        }
        UsbManager.ACTION_USB_DEVICE_DETACHED -> usb?.let { answers.remove(it.deviceName)?.complete(false) }
        ACTION_PERMISSION -> {
          val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
          if (usb != null && granted) rememberVendor(usb.vendorId)
          usb?.let { answers.remove(it.deviceName)?.complete(granted) }
        }
      }
      thread(name = "t3-usb-refresh") { refresh() }
    }
  }

  private fun manager() = app?.getSystemService(Context.USB_SERVICE) as UsbManager?

  private fun allowedVendors() =
    app?.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)?.getStringSet(ALLOWED_VENDORS, null)
      ?.mapNotNull { it.toIntOrNull() }?.toSet().orEmpty()

  private fun rememberVendor(vendorId: Int) {
    val preferences = app?.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE) ?: return
    val vendors = preferences.getStringSet(ALLOWED_VENDORS, null).orEmpty() + vendorId.toString()
    preferences.edit().putStringSet(ALLOWED_VENDORS, vendors).apply()
  }

  /** Rewrites the fake tree and tells watchers what changed. Safe to call any time. */
  @Synchronized
  fun refresh() {
    val context = app ?: return
    val allowed = devices().filter { it.allowed }
    runCatching { writeTree(GuestRuntime(context).rootfs, allowed) }
      .onFailure { Log.w(TAG, "USB tree not written", it) }
    val current = allowed.map { it.bus to it.dev }.toSet()
    val lines = (current - published).map { "add\t${it.first}\t${it.second}\n" } +
      (published - current).map { "remove\t${it.first}\t${it.second}\n" }
    published = current
    if (lines.isNotEmpty()) {
      watchers.forEach { socket -> if (!send(socket, lines.joinToString(""))) watchers.remove(socket) }
    }
    listeners.forEach { it() }
  }

  private fun writeTree(rootfs: File, allowed: List<Device>) {
    if (!File(rootfs, "usr").isDirectory) return
    val root = File(rootfs, "run/t3-usb")
    val sysfs = File(root, "sys/bus/usb/devices").apply { mkdirs() }
    val devfs = File(root, "dev/bus/usb").apply { mkdirs() }
    val chardev = File(root, "sys/dev/char").apply { mkdirs() }
    File(root, "socket").writeText(socketName(app ?: return))
    val names = allowed.associateBy { "${it.bus}-${it.dev}" }
    sysfs.listFiles()?.filter { it.name !in names }?.forEach { it.deleteRecursively() }
    devfs.listFiles()?.forEach { bus ->
      bus.listFiles()?.filter { "${bus.name.toIntOrNull()}-${it.name.toIntOrNull()}" !in names }?.forEach { it.delete() }
      if (bus.list().isNullOrEmpty()) bus.delete()
    }
    // adb names a device by the /sys/dev/char link of its usbfs node, whose number Linux derives from bus and device.
    val links = names.mapKeys { (_, device) -> "189:${(device.bus - 1) * 128 + device.dev - 1}" }
    chardev.listFiles()?.filter { it.name !in links }?.forEach { it.delete() }
    for ((link, device) in links) {
      val file = File(chardev, link)
      if (!file.exists()) Os.symlink("../../bus/usb/devices/${device.bus}-${device.dev}", file.path)
    }
    for ((name, device) in names) {
      val folder = File(sysfs, name).apply { mkdirs() }
      val usb = device.usb
      val attributes = mapOf(
        "busnum" to device.bus.toString(),
        "devnum" to device.dev.toString(),
        "idVendor" to "%04x".format(usb.vendorId),
        "idProduct" to "%04x".format(usb.productId),
        "manufacturer" to usb.manufacturerName.orEmpty(),
        "product" to usb.productName.orEmpty(),
        "serial" to runCatching { usb.serialNumber }.getOrNull().orEmpty(),
        // Android does not say which configuration is active. Phones in adb and fastboot use 1.
        "bConfigurationValue" to "1",
      )
      attributes.forEach { (key, value) -> File(folder, key).writeText("$value\n") }
      File(devfs, "%03d/%03d".format(device.bus, device.dev)).apply { parentFile?.mkdirs() }.createNewFile()
    }
  }

  private fun serve(name: String) {
    val server = try {
      LocalServerSocket(name)
    } catch (error: IOException) {
      Log.w(TAG, "USB socket unavailable", error)
      return
    }
    while (true) {
      val socket = runCatching { server.accept() }.getOrNull()
      if (socket == null) {
        Thread.sleep(1_000)
        continue
      }
      thread(name = "t3-usb-client", isDaemon = true) {
        runCatching { handle(socket) }.onFailure { Log.w(TAG, "USB request failed", it) }
      }
    }
  }

  private fun handle(socket: LocalSocket) {
    // The socket name is visible to every app, so only this app's own processes are served.
    if (socket.peerCredentials.uid != Process.myUid()) {
      socket.close()
      return
    }
    val request = readLine(socket)?.split('\t') ?: return socket.close()
    when (request.first()) {
      "open" -> socket.use { open(it, request.getOrNull(1)?.toIntOrNull(), request.getOrNull(2)?.toIntOrNull()) }
      "list" -> socket.use { list(it) }
      "allow" -> socket.use { allow(it, request) }
      "selftest" -> socket.use { selftest(it) }
      "watch" -> watch(socket)
      else -> socket.use { send(it, "error\tunknown request\n") }
    }
  }

  private fun open(socket: LocalSocket, bus: Int?, dev: Int?) {
    val device = devices().firstOrNull { it.bus == bus && it.dev == dev }
    val manager = manager()
    when {
      device == null || manager == null -> send(socket, "error\tnot attached\n")
      !device.allowed -> send(socket, "error\tnot allowed yet. Run t3-usb allow, or use Settings > This phone\n")
      else -> {
        val connection = manager.openDevice(device.usb)
        if (connection == null) {
          send(socket, "error\tAndroid could not open the device\n")
          return
        }
        try {
          ParcelFileDescriptor.fromFd(connection.fileDescriptor).use { send(socket, "ok\n", it.fileDescriptor) }
        } finally {
          connection.close()
        }
      }
    }
  }

  private fun list(socket: LocalSocket) {
    val lines = devices().joinToString("") { device ->
      val usb = device.usb
      val serial = if (device.allowed) runCatching { usb.serialNumber }.getOrNull() else null
      listOf(
        "device", device.bus, device.dev, usb.vendorId, usb.productId, if (device.allowed) 1 else 0,
        usb.manufacturerName, usb.productName, serial,
      ).joinToString("\t") { field(it) } + "\n"
    }
    send(socket, lines + "end\n")
  }

  private fun allow(socket: LocalSocket, request: List<String>) {
    val bus = request.getOrNull(1)?.toIntOrNull()
    val dev = request.getOrNull(2)?.toIntOrNull()
    val targets = devices().filter { request.getOrNull(1) == "all" || (it.bus == bus && it.dev == dev) }
    if (targets.isEmpty() && request.getOrNull(1) != "all") send(socket, "error\tno such device attached\n")
    for (device in targets.filter { !it.allowed }) {
      if (!send(socket, "asking\t${device.bus}\t${device.dev}\n")) return
      val answer = try {
        if (requestAccess(device.usb).get(ANSWER_SECONDS, TimeUnit.SECONDS)) "granted" else "denied"
      } catch (_: TimeoutException) {
        "error\t${device.bus}\t${device.dev}\tno answer on the phone"
      }
      val line = if (answer.startsWith("error")) answer else "$answer\t${device.bus}\t${device.dev}"
      if (!send(socket, "$line\n")) return
    }
    send(socket, "end\n")
  }

  // Lets t3-usb selftest prove fd passing works without a USB device.
  private fun selftest(socket: LocalSocket) {
    val (read, write) = ParcelFileDescriptor.createPipe()
    ParcelFileDescriptor.AutoCloseOutputStream(write).use { it.write("fd passing works\n".toByteArray()) }
    read.use { send(socket, "ok\n", it.fileDescriptor) }
  }

  private fun watch(socket: LocalSocket) {
    synchronized(this) {
      val current = published.joinToString("") { "add\t${it.first}\t${it.second}\n" }
      if (!send(socket, current + "ready\n")) return socket.close()
      watchers.add(socket)
    }
    // Holds the connection until the guest process goes away.
    runCatching { while (socket.inputStream.read() >= 0) Unit }
    watchers.remove(socket)
    socket.close()
  }

  private fun send(socket: LocalSocket, text: String, fd: FileDescriptor? = null): Boolean = synchronized(socket) {
    try {
      if (fd != null) socket.setFileDescriptorsForSend(arrayOf(fd))
      socket.outputStream.write(text.toByteArray())
      socket.outputStream.flush()
      true
    } catch (_: IOException) {
      false
    } finally {
      if (fd != null) socket.setFileDescriptorsForSend(null)
    }
  }

  private fun readLine(socket: LocalSocket): String? {
    val bytes = StringBuilder()
    val input = socket.inputStream
    while (bytes.length < 256) {
      val byte = input.read()
      if (byte < 0) return null
      if (byte == '\n'.code) return bytes.toString()
      bytes.append(byte.toChar())
    }
    return null
  }

  private fun field(value: Any?) = value?.toString().orEmpty().replace(Regex("[\t\n\r]"), " ")

  private fun address(usb: UsbDevice): Pair<Int, Int>? {
    val parts = usb.deviceName.removePrefix("/dev/bus/usb/").split('/')
    val bus = parts.getOrNull(0)?.toIntOrNull() ?: return null
    val dev = parts.getOrNull(1)?.toIntOrNull() ?: return null
    return bus to dev
  }

  @Suppress("DEPRECATION")
  private fun Intent.usbDevice(): UsbDevice? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
    } else {
      getParcelableExtra(UsbManager.EXTRA_DEVICE)
    }
}
