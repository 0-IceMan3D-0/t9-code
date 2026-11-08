package expo.modules.t3appicon

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

private const val ALIAS_MARKER = ".appicon."
private const val PENDING_KEY = "pending"
private const val CUSTOM_SHORTCUT_ID = "t3-custom-icon"
private const val ADAPTIVE_SIZE = 432
private const val SOURCE_SIZE = 512

class T3AppIconModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready", null)

  override fun definition() = ModuleDefinition {
    Name("T3AppIcon")

    Function("getState") {
      val ctx = context
      val shortcuts = shortcutManager(ctx)
      mapOf(
        "icon" to (pending(ctx) ?: enabledAlias(ctx)?.let(::presetId)),
        "presets" to aliases(ctx).map { presetId(it.name) },
        "pinSupported" to (shortcuts?.isRequestPinShortcutSupported == true),
        "customPinned" to (shortcuts?.pinnedShortcuts?.any { it.id == CUSTOM_SHORTCUT_ID && it.isEnabled } == true),
        "customImage" to sourceFile(ctx).takeIf { it.exists() }?.let { "${Uri.fromFile(it)}?v=${it.lastModified()}" },
      )
    }

    // Disabling the alias the task was launched from closes that task, so the switch waits for
    // applyPendingIcon, which the app calls once it is in the background.
    Function("setIcon") { id: String ->
      val ctx = context
      if (aliases(ctx).none { presetId(it.name) == id }) {
        throw CodedException("ERR_UNKNOWN_ICON", "No app icon named $id", null)
      }
      prefs(ctx).edit().putString(PENDING_KEY, id).apply()
    }

    // Enable the new alias before disabling the rest, so a launcher entry exists at every moment.
    Function("applyPendingIcon") {
      val ctx = context
      val id = pending(ctx) ?: return@Function null
      prefs(ctx).edit().remove(PENDING_KEY).apply()
      val pm = ctx.packageManager
      val all = aliases(ctx)
      val target = all.firstOrNull { presetId(it.name) == id } ?: return@Function null
      if (enabledAlias(ctx) == target.name) return@Function null
      pm.setComponentEnabledSetting(
        ComponentName(ctx.packageName, target.name),
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
        PackageManager.DONT_KILL_APP,
      )
      for (alias in all) {
        if (alias.name == target.name) continue
        pm.setComponentEnabledSetting(
          ComponentName(ctx.packageName, alias.name),
          PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
          PackageManager.DONT_KILL_APP,
        )
      }
      // A pinned shortcut is tied to a launcher activity; move ours to the alias that stays enabled.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val shortcuts = shortcutManager(ctx)
        if (shortcuts?.pinnedShortcuts?.any { it.id == CUSTOM_SHORTCUT_ID && it.isEnabled } == true) {
          loadSource(ctx)?.let { shortcuts.updateShortcuts(listOf(customShortcut(ctx, it))) }
        }
      }
    }

    AsyncFunction("pinCustomIcon") { uri: String ->
      val ctx = context
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction "unsupported"
      val shortcuts = shortcutManager(ctx) ?: return@AsyncFunction "unsupported"
      val source = decodeSquare(ctx, Uri.parse(uri))
      val file = sourceFile(ctx)
      file.parentFile?.mkdirs()
      file.outputStream().use { source.compress(Bitmap.CompressFormat.PNG, 100, it) }
      val info = customShortcut(ctx, source)
      val pinned = shortcuts.pinnedShortcuts.firstOrNull { it.id == CUSTOM_SHORTCUT_ID }
      if (pinned != null && pinned.isEnabled) {
        shortcuts.updateShortcuts(listOf(info))
        return@AsyncFunction "updated"
      }
      if (pinned != null) shortcuts.enableShortcuts(listOf(CUSTOM_SHORTCUT_ID))
      if (!shortcuts.isRequestPinShortcutSupported) return@AsyncFunction "unsupported"
      if (!shortcuts.requestPinShortcut(info, null)) return@AsyncFunction "unsupported"
      "requested"
    }

    // Apps cannot unpin; a disabled shortcut stays greyed out until the person removes it.
    AsyncFunction("removeCustomIcon") {
      val ctx = context
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        shortcutManager(ctx)?.disableShortcuts(
          listOf(CUSTOM_SHORTCUT_ID),
          "Removed in Settings. Long-press to remove it from the home screen.",
        )
      }
      sourceFile(ctx).delete()
    }
  }

  private fun prefs(ctx: Context) = ctx.getSharedPreferences("t3_app_icon", Context.MODE_PRIVATE)

  private fun pending(ctx: Context) = prefs(ctx).getString(PENDING_KEY, null)

  private fun presetId(aliasName: String) = aliasName.substringAfterLast(ALIAS_MARKER)

  private fun aliases(ctx: Context): List<ActivityInfo> {
    val flags = PackageManager.GET_ACTIVITIES or PackageManager.MATCH_DISABLED_COMPONENTS
    val info = ctx.packageManager.getPackageInfo(ctx.packageName, flags)
    return info.activities.orEmpty().filter { it.targetActivity != null && it.name.contains(ALIAS_MARKER) }
  }

  private fun enabledAlias(ctx: Context): String? {
    val pm = ctx.packageManager
    return aliases(ctx).firstOrNull {
      when (pm.getComponentEnabledSetting(ComponentName(ctx.packageName, it.name))) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> it.enabled
        else -> false
      }
    }?.name
  }

  private fun shortcutManager(ctx: Context): ShortcutManager? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.getSystemService(ShortcutManager::class.java) else null

  private fun sourceFile(ctx: Context) = File(ctx.filesDir, "app-icon/custom.png")

  private fun loadSource(ctx: Context): Bitmap? =
    sourceFile(ctx).takeIf { it.exists() }?.let { BitmapFactory.decodeFile(it.path) }

  private fun customShortcut(ctx: Context, source: Bitmap): ShortcutInfo {
    val launcher = enabledAlias(ctx)
    val target = aliases(ctx).firstOrNull()?.targetActivity
      ?: throw CodedException("ERR_NO_ACTIVITY", "The app has no launcher activity", null)
    val intent = Intent(Intent.ACTION_MAIN)
      .setComponent(ComponentName(ctx.packageName, target))
      .addCategory(Intent.CATEGORY_LAUNCHER)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    val label = ctx.applicationInfo.loadLabel(ctx.packageManager).toString()
    return ShortcutInfo.Builder(ctx, CUSTOM_SHORTCUT_ID)
      .setShortLabel(label)
      .setLongLabel(label)
      .setIcon(Icon.createWithAdaptiveBitmap(adaptiveLayer(source)))
      .setIntent(intent)
      .apply { if (launcher != null) setActivity(ComponentName(ctx.packageName, launcher)) }
      .build()
  }

  /** The picked square fills the 72dp viewport of a 108dp adaptive layer; the bleed repeats it. */
  private fun adaptiveLayer(source: Bitmap): Bitmap {
    val out = Bitmap.createBitmap(ADAPTIVE_SIZE, ADAPTIVE_SIZE, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    canvas.drawBitmap(source, null, Rect(0, 0, ADAPTIVE_SIZE, ADAPTIVE_SIZE), paint)
    val inset = ADAPTIVE_SIZE * 18 / 108
    canvas.drawBitmap(source, null, Rect(inset, inset, ADAPTIVE_SIZE - inset, ADAPTIVE_SIZE - inset), paint)
    return out
  }

  private fun decodeSquare(ctx: Context, uri: Uri): Bitmap {
    val resolver = ctx.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      throw CodedException("ERR_IMAGE", "That file is not an image this phone can read", null)
    }
    var sample = 1
    while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= SOURCE_SIZE) sample *= 2
    val decoded = resolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: throw CodedException("ERR_IMAGE", "Could not read the image", null)
    val side = minOf(decoded.width, decoded.height)
    val square = Bitmap.createBitmap(decoded, (decoded.width - side) / 2, (decoded.height - side) / 2, side, side)
    return Bitmap.createScaledBitmap(square, minOf(side, SOURCE_SIZE), minOf(side, SOURCE_SIZE), true)
  }
}
