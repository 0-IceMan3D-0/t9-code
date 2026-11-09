package expo.modules.t3localserver

import android.content.Context

class LocalServerOptions(context: Context) {
  private val preferences = context.getSharedPreferences("t3_local_server", Context.MODE_PRIVATE)

  /** Read natively when the app process starts, so the server starts before any screen opens. */
  var startOnAppOpen: Boolean
    get() = preferences.getBoolean("startOnAppOpen", false)
    set(value) = preferences.edit().putBoolean("startOnAppOpen", value).apply()

  /** Read by [AutoStop] in the background, so it lives here rather than in JS. */
  var stopOnLeave: Boolean
    get() = preferences.getBoolean("stopOnLeave", false)
    set(value) = preferences.edit().putBoolean("stopOnLeave", value).apply()

  /** How long after leaving the app [AutoStop] stops the server. */
  var stopAfterMinutes: Int
    get() = preferences.getInt("stopAfterMinutes", DEFAULT_STOP_AFTER_MINUTES)
    set(value) = preferences.edit().putInt("stopAfterMinutes", value.coerceIn(MIN_STOP_AFTER_MINUTES, MAX_STOP_AFTER_MINUTES)).apply()

  var sharedStorage: Boolean
    get() = preferences.getBoolean("sharedStorage", false)
    set(value) = preferences.edit().putBoolean("sharedStorage", value).apply()

  /** The app's deep link scheme, from JS, so the tile and shortcuts can open a screen. */
  var appScheme: String?
    get() = preferences.getString("appScheme", null)
    set(value) = preferences.edit().putString("appScheme", value).apply()

  /** Set once the one-time battery hint was answered either way, so it never asks again. */
  var batteryHintDismissed: Boolean
    get() = preferences.getBoolean("batteryHintDismissed", false)
    set(value) = preferences.edit().putBoolean("batteryHintDismissed", value).apply()

  companion object {
    const val DEFAULT_STOP_AFTER_MINUTES = 2
    const val MIN_STOP_AFTER_MINUTES = 1
    const val MAX_STOP_AFTER_MINUTES = 240
  }
}
