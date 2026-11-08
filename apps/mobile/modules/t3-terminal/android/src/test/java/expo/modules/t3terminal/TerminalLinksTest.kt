package expo.modules.t3terminal

import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalLinksTest {
  private fun grid(cols: Int, vararg lines: String): Array<String> =
    lines.flatMap { line -> (0 until cols).map { line.getOrNull(it)?.toString() ?: "" } }.toTypedArray()

  private fun urls(cols: Int, vararg lines: String) =
    TerminalLinks.find(cols, lines.size, grid(cols, *lines)).map { it.url }

  @Test
  fun findsWebAndLocalLinks() {
    assertEquals(
      listOf("https://example.com/a?b=1", "http://127.0.0.1:5173/", "http://localhost:3000"),
      urls(80, "see https://example.com/a?b=1.", "  Local: http://127.0.0.1:5173/", "open localhost:3000 now"),
    )
  }

  @Test
  fun pointsWildcardHostsAtThisDevice() {
    assertEquals(
      listOf("http://127.0.0.1:8000/"),
      urls(80, "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ..."),
    )
  }

  @Test
  fun keepsBalancedParenthesesAndDropsOthers() {
    assertEquals("https://en.wikipedia.org/wiki/A_(b)", TerminalLinks.trim("https://en.wikipedia.org/wiki/A_(b)"))
    assertEquals("https://example.com/x", TerminalLinks.trim("https://example.com/x),"))
  }

  @Test
  fun joinsALinkTheTerminalWrapped() {
    val links = TerminalLinks.find(10, 3, grid(10, "go https:/", "/a.dev/xy", "done"))
    assertEquals(listOf("https://a.dev/xy"), links.map { it.url })
    assertEquals(
      listOf(TerminalLink.Span(0, 3, 9), TerminalLink.Span(1, 0, 8)),
      links.single().spans,
    )
    assertEquals(links.single(), TerminalLinks.at(links, 4, 1))
    assertEquals(null, TerminalLinks.at(links, 1, 2))
  }

  @Test
  fun ignoresEmailsAndPaths() {
    assertEquals(emptyList<String>(), urls(80, "git@github.com: Permission denied", "/usr/localhost:80"))
  }
}
