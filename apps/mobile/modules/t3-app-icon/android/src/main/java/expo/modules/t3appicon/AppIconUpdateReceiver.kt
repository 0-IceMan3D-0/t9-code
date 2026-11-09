package expo.modules.t3appicon

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Runs after each app update, before the user can find the app missing from the launcher. */
class AppIconUpdateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) AppIconStyle.ensureLauncherEntry(context)
  }
}
