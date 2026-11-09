package expo.modules.t3homewidgets

/**
 * When widget data may be out of date, and when its "Updated … ago" stamp next needs redrawing.
 * Pure, so the host can test it without Android.
 *
 * Data is fresh while the process that published it is still running (alive) and the app said
 * everything it watches was connected (live). A live process re-confirms fresh data every
 * [CHECK_INTERVAL_MILLIS]; once the process is gone the next check finds a different process and
 * shows the stamp, so a dead process is noticed within that interval.
 */
object WidgetFreshness {
  const val CHECK_INTERVAL_MILLIS = 15 * 60_000L
  private const val MINUTE = 60_000L
  private const val HOUR = 60 * MINUTE

  /** Ages at which the stamp's text changes; after the last one it stays "over a day ago". */
  private val STEPS = longArrayOf(
    MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, 45 * MINUTE,
    HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR, 8 * HOUR, 12 * HOUR, 18 * HOUR, 24 * HOUR,
  )

  fun isStale(alive: Boolean, live: Boolean) = !alive || !live

  /** What the stamp counts from: the last confirmation for live data, else when it was last live. */
  fun since(live: Boolean, asOf: Long, confirmedAt: Long) = if (live) confirmedAt else minOf(asOf, confirmedAt)

  fun label(ageMillis: Long): String {
    val age = ageMillis.coerceAtLeast(0)
    return when {
      age < MINUTE -> "Updated just now"
      age < HOUR -> "Updated ${age / MINUTE} min ago"
      age < 24 * HOUR -> "Updated ${age / HOUR} h ago"
      else -> "Updated over a day ago"
    }
  }

  /** Milliseconds until the stamp for data this old changes, or null once it never will. */
  fun untilNextLabel(ageMillis: Long): Long? {
    val age = ageMillis.coerceAtLeast(0)
    return STEPS.firstOrNull { it > age }?.minus(age)
  }

  /** Absolute time of the next check for one piece of data, or null when none is needed. */
  fun nextCheck(now: Long, alive: Boolean, live: Boolean, asOf: Long, confirmedAt: Long): Long? {
    if (!isStale(alive, live)) return now + CHECK_INTERVAL_MILLIS
    val since = since(live, asOf, confirmedAt)
    return untilNextLabel(now - since)?.let { now + it }
  }
}

/** Layout decisions from a widget's size in dp. */
object WidgetSizing {
  private const val ROW_DP = 44
  private const val CHROME_DP = 24 + 28 + 18
  const val MAX_ROWS = 6

  /** One launcher row is about 40 to 100 dp; below this the compact layouts are used. */
  fun isCompact(heightDp: Int) = heightDp in 1 until 100

  /** Up to about one and a half rows: room for one line between header and button. */
  fun isShort(heightDp: Int) = heightDp in 1 until 170

  fun threadRows(heightDp: Int): Int =
    if (heightDp <= 0) 3 else if (isCompact(heightDp)) 1 else ((heightDp - CHROME_DP) / ROW_DP).coerceIn(1, MAX_ROWS)

  /** Labels under the quick action icons need about 72 dp per action. */
  fun showActionLabels(widthDp: Int, heightDp: Int, actions: Int) =
    (widthDp <= 0 || widthDp / actions.coerceAtLeast(1) >= 72) && (heightDp <= 0 || heightDp >= 64)
}

/** Short labels the widgets show. */
object WidgetText {
  private const val MIB = 1L shl 20

  /** Rounded so small swings do not redraw the widget: 10 MB steps, then 0.1 GB. */
  fun memory(bytes: Long): String {
    val mb = bytes / MIB
    return if (mb < 1000) "${(mb / 10) * 10} MB" else "${mb * 10 / 1024 / 10.0} GB"
  }

  fun activeThreads(total: Int, needs: Int): String = when {
    total == 0 -> "No agents running"
    needs == 0 -> "$total working"
    needs == total -> if (needs == 1) "1 needs you" else "$needs need you"
    else -> "${total - needs} working · $needs ${if (needs == 1) "needs" else "need"} you"
  }

  fun port(url: String): String = url.substringAfterLast(':').trimEnd('/').let { if (it.all(Char::isDigit) && it.isNotEmpty()) "Port $it" else "Web server" }

  fun webServer(url: String, command: String): String {
    val host = url.removePrefix("http://").removePrefix("https://").trimEnd('/')
    val program = command.trim().substringBefore(' ').substringAfterLast('/')
    return if (program.isEmpty()) host else "$host · $program"
  }
}
