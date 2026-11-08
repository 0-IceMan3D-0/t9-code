package expo.modules.t3homewidgets

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3HomeWidgetsModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext).applicationContext
  private val placedListener: () -> Unit = { sendEvent(PLACED_EVENT, mapOf<String, Any>()) }
  @Volatile private var iconShown: String? = null

  override fun definition() = ModuleDefinition {
    Name("T3HomeWidgets")
    Events(PLACED_EVENT)

    OnCreate {
      HomeWidgets.addPlacedListener(placedListener)
      appContext.reactContext?.applicationContext?.let { app ->
        HomeWidgets.post {
          ServerWidgetWatcher.start(app)
          iconShown = WidgetIcon.presetId(app)
        }
      }
    }
    OnDestroy { HomeWidgets.removePlacedListener(placedListener) }

    // An icon choice is stored at once and applied when the app goes to the background.
    OnActivityEntersBackground {
      val app = context
      HomeWidgets.post {
        val icon = WidgetIcon.presetId(app)
        if (icon != iconShown) {
          iconShown = icon
          HomeWidgets.refreshAll(app)
        }
      }
    }

    Function("configure") { scheme: String -> HomeWidgets.configure(context, scheme) }
    Function("placed") { HomeWidgets.placed(context).map { it.id } }
    Function("publish") { key: String, json: String -> HomeWidgets.publish(context, key, json) }
    Function("read") { key: String -> HomeWidgets.readRaw(context, key) }
  }

  companion object {
    const val PLACED_EVENT = "onPlacedChanged"
  }
}
