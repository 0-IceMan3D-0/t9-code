package expo.modules.t3localserver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.io.File
import kotlin.concurrent.thread

/** Debug only: runs a command in the app's real process context, for checks from adb. */
class ProbeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val command = intent.getStringExtra("cmd") ?: return
    val guest = intent.getBooleanExtra("guest", true)
    val name = intent.getStringExtra("out") ?: "probe"
    val app = context.applicationContext
    thread {
      val out = File(app.filesDir, "$name.out")
      val builder =
        if (guest) GuestRuntime(app).process(listOf("/bin/sh", "-c", command))
        else ProcessBuilder("/system/bin/sh", "-c", command).redirectErrorStream(true)
      val code = runCatching {
        val process = builder.redirectOutput(out).start()
        process.waitFor()
      }.getOrElse { error ->
        out.writeText(error.toString())
        -1
      }
      File(app.filesDir, "$name.done").writeText("$code\n")
    }
  }
}
