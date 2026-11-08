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
import android.os.PersistableBundle
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import org.json.JSONArray

private const val ALIAS_MARKER = ".appicon."
private const val PENDING_KEY = "pending"
private const val CUSTOM_SHORTCUT_ID = "t3-custom-icon"
private const val ADAPTIVE_SIZE = 432
private const val SOURCE_SIZE = 512
private const val ICON_EXTRA = "icon"

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
      // Android removes dynamic shortcuts of a disabled alias, so they are read before the switch.
      val dynamic = shortcutManager(ctx)?.dynamicShortcuts.orEmpty()
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
      moveShortcuts(ctx, dynamic, target.name)
      // A pinned shortcut is tied to a launcher activity; move ours to the alias that stays enabled.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val shortcuts = shortcutManager(ctx)
        if (shortcuts?.pinnedShortcuts?.any { it.id == CUSTOM_SHORTCUT_ID && it.isEnabled } == true) {
          loadSource(ctx)?.let { shortcuts.updateShortcuts(listOf(customShortcut(ctx, it))) }
        }
      }
    }

    // JSON, because an expo Record list argument left an unresolved reified type in this module.
    Function("setShortcuts") { json: String -> publishShortcuts(context, JSONArray(json)) }

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

  /** Each item: id, title, icon, and either url (a deep link) or className and action. */
  private fun publishShortcuts(ctx: Context, items: JSONArray) {
    val shortcuts = shortcutManager(ctx) ?: return
    val launcher = ComponentName(ctx.packageName, enabledAlias(ctx) ?: return)
    val published = ArrayList<ShortcutInfo>()
    for (index in 0 until items.length()) {
      val item = items.getJSONObject(index)
      val icon = item.optString("icon").ifEmpty { null }
      val intent = when {
        item.has("className") -> Intent(item.optString("action", Intent.ACTION_MAIN))
          .setClassName(ctx.packageName, item.getString("className"))
        item.has("url") -> Intent(Intent.ACTION_VIEW, Uri.parse(item.getString("url")))
          .setClassName(ctx.packageName, mainActivity(ctx))
        else -> continue
      }
      val title = item.getString("title")
      published += ShortcutInfo.Builder(ctx, item.getString("id"))
        .setShortLabel(title)
        .setLongLabel(title)
        .setIntent(intent)
        .setRank(index)
        .setActivity(launcher)
        .setExtras(PersistableBundle().apply { putString(ICON_EXTRA, icon) })
        .apply { iconResource(ctx, icon)?.let { setIcon(Icon.createWithResource(ctx, it)) } }
        .build()
    }
    shortcuts.dynamicShortcuts = published
  }

  private fun mainActivity(ctx: Context) = aliases(ctx).firstOrNull()?.targetActivity
    ?: throw CodedException("ERR_NO_ACTIVITY", "The app has no launcher activity", null)

  private fun iconResource(ctx: Context, name: String?): Int? {
    if (name == null) return null
    val res = ctx.resources
    return res.getIdentifier(name, "drawable", ctx.packageName).takeIf { it != 0 }
      ?: res.getIdentifier(name, "mipmap", ctx.packageName).takeIf { it != 0 }
  }

  /** Republishes shortcuts read before an icon switch on the alias that is now enabled. */
  private fun moveShortcuts(ctx: Context, before: List<ShortcutInfo>, launcher: String) {
    if (before.isEmpty()) return
    val shortcuts = shortcutManager(ctx) ?: return
    val moved = before.filter { it.isEnabled }.mapNotNull { old ->
      val intents = old.intents ?: return@mapNotNull null
      ShortcutInfo.Builder(ctx, old.id)
        .setShortLabel(old.shortLabel ?: old.id)
        .setLongLabel(old.longLabel ?: old.shortLabel ?: old.id)
        .setIntents(intents)
        .setRank(old.rank)
        .setActivity(ComponentName(ctx.packageName, launcher))
        .apply {
          old.extras?.let { extras ->
            setExtras(extras)
            iconResource(ctx, extras.getString(ICON_EXTRA))?.let { setIcon(Icon.createWithResource(ctx, it)) }
          }
        }
        .build()
    }
    runCatching { shortcuts.dynamicShortcuts = moved }.onFailure { Log.w("T3AppIcon", "Could not move shortcuts", it) }
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
