package expo.modules.t3terminal

/** A link on screen: [url] is what opens, [spans] the cells it covers, row by row. */
internal data class TerminalLink(val url: String, val spans: List<Span>) {
  data class Span(val row: Int, val startCol: Int, val endCol: Int)

  fun contains(col: Int, row: Int) = spans.any { it.row == row && col in it.startCol..it.endCol }
}

/**
 * Finds web links in the visible grid. A row whose last cell is filled is taken to continue on the
 * next row, so links the terminal wrapped stay whole.
 */
internal object TerminalLinks {
  private val PATTERN = Regex(
    """(?<![\w.@/-])(?:https?://[^\s<>"'`]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}(?:/[^\s<>"'`]*)?)""",
    RegexOption.IGNORE_CASE,
  )
  private const val TRAILING = ".,;:!?'\""
  private val CLOSERS = mapOf(')' to '(', ']' to '[', '}' to '{', '>' to '<')

  fun find(cols: Int, rows: Int, cellText: Array<String>): List<TerminalLink> {
    if (cols <= 0 || rows <= 0 || cellText.size < cols * rows) return emptyList()
    val links = ArrayList<TerminalLink>()
    var row = 0
    while (row < rows) {
      // One logical line: its text and, for each character, the cell it came from.
      val text = StringBuilder()
      val cells = ArrayList<Int>()
      var last = row
      while (true) {
        for (col in 0 until cols) {
          val cell = cellText[last * cols + col].ifEmpty { " " }
          repeat(cell.length) { cells.add(last * cols + col) }
          text.append(cell)
        }
        val wraps = cellText[last * cols + cols - 1].isNotBlank()
        if (!wraps || last + 1 >= rows) break
        last += 1
      }
      for (match in PATTERN.findAll(text)) {
        val raw = trim(match.value)
        if (raw.isEmpty()) continue
        val first = match.range.first
        val end = first + raw.length - 1
        links.add(TerminalLink(openable(raw), spans(cells.subList(first, end + 1), cols)))
      }
      row = last + 1
    }
    return links
  }

  fun at(links: List<TerminalLink>, col: Int, row: Int) = links.firstOrNull { it.contains(col, row) }

  /** Drops sentence punctuation and closing brackets that the link did not open. */
  internal fun trim(value: String): String {
    var end = value.length
    while (end > 0) {
      val last = value[end - 1]
      val opener = CLOSERS[last]
      val drop = when {
        last in TRAILING -> true
        opener != null -> value.substring(0, end).count { it == opener } < value.substring(0, end).count { it == last }
        else -> false
      }
      if (!drop) break
      end -= 1
    }
    return value.substring(0, end)
  }

  /** Adds a scheme to bare host:port links and points wildcard hosts at this device. */
  internal fun openable(value: String): String {
    val withScheme = if (value.contains("://")) value else "http://$value"
    return withScheme.replaceFirst(WILDCARD_HOST, "$1127.0.0.1")
  }

  private val WILDCARD_HOST = Regex("""^(https?://)(?:0\.0\.0\.0|\[::\])(?=[:/]|$)""", RegexOption.IGNORE_CASE)

  private fun spans(cells: List<Int>, cols: Int): List<TerminalLink.Span> =
    cells.distinct().groupBy { it / cols }.map { (row, indexes) ->
      TerminalLink.Span(row, indexes.minOf { it % cols }, indexes.maxOf { it % cols })
    }
}
