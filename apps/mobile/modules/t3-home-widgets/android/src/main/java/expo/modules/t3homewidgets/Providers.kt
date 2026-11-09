package expo.modules.t3homewidgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Bundle

/** No periodic updates: widgets redraw when their data changes or the stamp's text does. */
abstract class HomeWidgetProvider(private val kind: WidgetKind) : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = drawAsync(context, ids)

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) =
    drawAsync(context, intArrayOf(id))

  override fun onDeleted(context: Context, ids: IntArray) {
    HomeWidgets.forget(ids)
    HomeWidgets.post { HomeWidgets.placementChanged(context.applicationContext) }
  }

  override fun onDisabled(context: Context) {
    HomeWidgets.post { HomeWidgets.placementChanged(context.applicationContext) }
  }

  private fun drawAsync(context: Context, ids: IntArray) {
    val result = goAsync()
    val app = context.applicationContext
    HomeWidgets.post {
      try {
        HomeWidgets.placementChanged(app)
        ServerWidgetWatcher.start(app)
        HomeWidgets.render(app, kind, ids, force = true)
      } finally {
        result.finish()
      }
    }
  }
}

class WorkingThreadsWidget : HomeWidgetProvider(WidgetKind.WORKING)

class RecentThreadsWidget : HomeWidgetProvider(WidgetKind.RECENT)

class ServerWidget : HomeWidgetProvider(WidgetKind.SERVER)

class QuickActionsWidget : HomeWidgetProvider(WidgetKind.ACTIONS)

class UsageTodayWidget : HomeWidgetProvider(WidgetKind.USAGE)

class NewThreadBarWidget : HomeWidgetProvider(WidgetKind.PROMPT)

class GaugesWidget : HomeWidgetProvider(WidgetKind.GAUGES)

class StatusLineWidget : HomeWidgetProvider(WidgetKind.STATUS)

class LimitsWidget : HomeWidgetProvider(WidgetKind.LIMITS)

class TokensTodayWidget : HomeWidgetProvider(WidgetKind.TOKENS)

/**
 * Created at every start of the app's process, before any screen or service. Lets the server
 * and quick action widgets follow the server when the tile or a shortcut started it.
 */
class HomeWidgetsInit : ContentProvider() {
  override fun onCreate(): Boolean {
    val app = context?.applicationContext ?: return true
    HomeWidgets.post {
      val placed = HomeWidgets.placed(app)
      if (placed.isEmpty()) return@post
      ServerWidgetWatcher.start(app)
      // A new process means the server stopped with the old one, unless its service restarts it.
      HomeWidgets.refresh(app, *WidgetKind.SERVER_STATE, *WidgetKind.WEB_SERVER)
      HomeWidgets.scheduleCheck(app)
    }
    return true
  }

  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int = 0

  override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int = 0
}
