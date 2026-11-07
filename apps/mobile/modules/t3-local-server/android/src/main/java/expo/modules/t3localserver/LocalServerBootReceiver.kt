package expo.modules.t3localserver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class LocalServerBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    val options = LocalServerOptions(context)
    if (options.startAtBoot && GuestRuntime(context).isInstalled) LocalServerService.start(context)
  }
}
