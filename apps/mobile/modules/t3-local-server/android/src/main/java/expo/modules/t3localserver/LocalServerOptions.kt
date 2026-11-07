package expo.modules.t3localserver

import android.content.Context

class LocalServerOptions(context: Context) {
  private val preferences = context.getSharedPreferences("t3_local_server", Context.MODE_PRIVATE)

  var startAtBoot: Boolean
    get() = preferences.getBoolean("startAtBoot", false)
    set(value) = preferences.edit().putBoolean("startAtBoot", value).apply()

  var sharedStorage: Boolean
    get() = preferences.getBoolean("sharedStorage", false)
    set(value) = preferences.edit().putBoolean("sharedStorage", value).apply()
}
