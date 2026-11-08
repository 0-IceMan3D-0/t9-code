package expo.modules.t3appicon

import android.app.Activity
import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Log

/**
 * The chosen icon preset, for everything outside the launcher that should look like it: the
 * notification small icon and accent, and the launch splash. Other modules read it from here.
 */
object AppIconStyle {
  private const val TAG = "T3AppIcon"
  private const val ALIAS_MARKER = ".appicon."
  internal const val PREFS = "t3_app_icon"
  internal const val PENDING_KEY = "pending"
  private const val SPLASH_KEY = "splashTheme"
  private const val LAUNCH_THEME = "T3LaunchTheme"

  @Volatile private var cached: String? = null

  /** The pending choice wins: it becomes the launcher alias once the app is in the background. */
  fun presetId(ctx: Context): String =
    cached ?: (pending(ctx) ?: enabledAlias(ctx)?.let(::aliasPreset) ?: "classic").also { cached = it }

  fun smallIcon(ctx: Context): Int = preset(ctx).smallIcon

  fun accent(ctx: Context): Int = preset(ctx).accent

  internal fun changed(ctx: Context, activity: Activity?) {
    cached = null
    restyleNotifications(ctx)
    if (activity != null) syncSplashTheme(activity)
  }

  private fun preset(ctx: Context) = APP_ICON_PRESETS[presetId(ctx)] ?: APP_ICON_PRESETS.getValue("classic")

  /**
   * Android 13+ shows the persisted splash theme for every launch of the package, including
   * notification taps and deep links that start MainActivity rather than the launcher alias.
   * MainActivity's manifest theme has no icon, so 12 and 12L draw the launched component's icon
   * (right for the alias, Classic for MainActivity) and older versions only the background.
   */
  internal fun syncSplashTheme(activity: Activity) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val id = presetId(activity)
    val prefs = prefs(activity)
    if (prefs.getString(SPLASH_KEY, null) == id) return
    val theme = launchTheme(activity, id) ?: return
    runCatching { activity.splashScreen.setSplashScreenTheme(theme) }
      .onSuccess { prefs.edit().putString(SPLASH_KEY, id).apply() }
      .onFailure { Log.w(TAG, "Could not set the splash theme", it) }
  }

  // Styles live in the app's styles.xml (withAndroidAppIcons), not in this library.
  private fun launchTheme(ctx: Context, id: String): Int? =
    ctx.resources.getIdentifier("${LAUNCH_THEME}_$id", "style", ctx.packageName).takeIf { it != 0 }

  /** Re-posts this app's notifications whose small icon or accent came from the old preset. */
  private fun restyleNotifications(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
    val manager = ctx.getSystemService(NotificationManager::class.java) ?: return
    val previous = APP_ICON_PRESETS.values
    val next = preset(ctx)
    for (posted in runCatching { manager.activeNotifications }.getOrDefault(emptyArray())) {
      val old = posted.notification
      // getResId throws for bitmap and URI icons, which are never ours.
      val icon = runCatching { old.smallIcon?.resId }.getOrNull()
      if (previous.none { it.smallIcon == icon }) continue
      runCatching {
        val builder = Notification.Builder.recoverBuilder(ctx, old)
          .setSmallIcon(Icon.createWithResource(ctx, next.smallIcon))
          .setOnlyAlertOnce(true)
        if (previous.any { it.accent == old.color }) builder.setColor(next.accent)
        old.publicVersion?.let { hidden ->
          builder.setPublicVersion(
            Notification.Builder.recoverBuilder(ctx, hidden)
              .setSmallIcon(Icon.createWithResource(ctx, next.smallIcon))
              .build(),
          )
        }
        manager.notify(posted.tag, posted.id, builder.build())
      }.onFailure { Log.w(TAG, "Could not restyle notification ${posted.id}", it) }
    }
  }

  internal fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  internal fun pending(ctx: Context) = prefs(ctx).getString(PENDING_KEY, null)

  internal fun aliasPreset(aliasName: String) = aliasName.substringAfterLast(ALIAS_MARKER)

  internal fun aliases(ctx: Context): List<ActivityInfo> {
    val flags = PackageManager.GET_ACTIVITIES or PackageManager.MATCH_DISABLED_COMPONENTS
    val info = ctx.packageManager.getPackageInfo(ctx.packageName, flags)
    return info.activities.orEmpty().filter { it.targetActivity != null && it.name.contains(ALIAS_MARKER) }
  }

  internal fun enabledAlias(ctx: Context): String? {
    val pm = ctx.packageManager
    return aliases(ctx).firstOrNull {
      when (pm.getComponentEnabledSetting(ComponentName(ctx.packageName, it.name))) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> it.enabled
        else -> false
      }
    }?.name
  }
}
