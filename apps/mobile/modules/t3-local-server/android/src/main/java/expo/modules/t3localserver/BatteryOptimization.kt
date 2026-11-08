package expo.modules.t3localserver

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * OnePlus and other vendors stop an optimised app's background work, foreground service or not,
 * which ends agents in the middle of a run. Android's own prompt is the only way to opt out.
 */
object BatteryOptimization {
  fun isOptimized(context: Context): Boolean {
    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    return !power.isIgnoringBatteryOptimizations(context.packageName)
  }

  /** Opens the most direct screen this phone has, and names it, or returns "none". */
  @SuppressLint("BatteryLife")
  fun openSettings(context: Context): String {
    val packageUri = Uri.parse("package:${context.packageName}")
    val candidates = listOfNotNull(
      if (isOptimized(context)) "prompt" to Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri) else null,
      "list" to Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
      "details" to Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri),
    )
    // No resolveActivity check: package visibility hides Settings from it on API 30 and newer.
    for ((kind, intent) in candidates) {
      try {
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return kind
      } catch (_: ActivityNotFoundException) {
      } catch (_: SecurityException) {
      }
    }
    return "none"
  }
}
