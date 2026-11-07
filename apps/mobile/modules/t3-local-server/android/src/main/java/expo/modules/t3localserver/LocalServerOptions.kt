package expo.modules.t3localserver

import android.content.Context

class LocalServerOptions(context: Context) {
  private val preferences = context.getSharedPreferences("t3_local_server", Context.MODE_PRIVATE)

  /** Read natively when the app process starts, so the server starts before any screen opens. */
  var startOnAppOpen: Boolean
    get() = preferences.getBoolean("startOnAppOpen", false)
    set(value) = preferences.edit().putBoolean("startOnAppOpen", value).apply()

  var sharedStorage: Boolean
    get() = preferences.getBoolean("sharedStorage", false)
    set(value) = preferences.edit().putBoolean("sharedStorage", value).apply()
}
