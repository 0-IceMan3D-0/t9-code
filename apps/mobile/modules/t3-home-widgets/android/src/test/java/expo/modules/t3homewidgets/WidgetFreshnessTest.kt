package expo.modules.t3homewidgets

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetFreshnessTest {
  private val minute = 60_000L
  private val hour = 60 * minute

  @Test
  fun freshOnlyWhileThePublishingProcessRunsAndEverythingIsConnected() {
    assertFalse(WidgetFreshness.isStale(alive = true, live = true))
    assertTrue(WidgetFreshness.isStale(alive = false, live = true))
    assertTrue(WidgetFreshness.isStale(alive = true, live = false))
  }

  @Test
  fun countsFromTheLastConfirmationOrTheLastLiveMoment() {
    assertEquals(500L, WidgetFreshness.since(live = true, asOf = 100, confirmedAt = 500))
    assertEquals(100L, WidgetFreshness.since(live = false, asOf = 100, confirmedAt = 500))
  }

  @Test
  fun labelsFloorTheAge() {
    assertEquals("Updated just now", WidgetFreshness.label(59_999))
    assertEquals("Updated 1 min ago", WidgetFreshness.label(minute))
    assertEquals("Updated 59 min ago", WidgetFreshness.label(hour - 1))
    assertEquals("Updated 2 h ago", WidgetFreshness.label(2 * hour + 59 * minute))
    assertEquals("Updated over a day ago", WidgetFreshness.label(30 * hour))
    assertEquals("Updated just now", WidgetFreshness.label(-5))
  }

  @Test
  fun redrawsAtTheNextStepAndStopsAfterADay() {
    assertEquals(minute, WidgetFreshness.untilNextLabel(0))
    assertEquals(2 * minute, WidgetFreshness.untilNextLabel(3 * minute))
    assertEquals(hour, WidgetFreshness.untilNextLabel(23 * hour))
    assertNull(WidgetFreshness.untilNextLabel(24 * hour))
  }

  @Test
  fun freshDataIsReconfirmedAndStaleDataFollowsItsStamp() {
    val now = 10 * hour
    assertEquals(now + WidgetFreshness.CHECK_INTERVAL_MILLIS, WidgetFreshness.nextCheck(now, true, true, 0, now))
    assertEquals(now + 5 * minute, WidgetFreshness.nextCheck(now, false, true, 0, now - 10 * minute))
    assertNull(WidgetFreshness.nextCheck(now, true, false, now - 25 * hour, now))
  }

  @Test
  fun rowsFollowTheHeight() {
    assertEquals(1, WidgetSizing.threadRows(60))
    assertEquals(1, WidgetSizing.threadRows(110))
    assertEquals(2, WidgetSizing.threadRows(180))
    assertEquals(6, WidgetSizing.threadRows(800))
    assertEquals(3, WidgetSizing.threadRows(0))
    assertTrue(WidgetSizing.isShort(118))
    assertFalse(WidgetSizing.isShort(180))
    assertFalse(WidgetSizing.showActionLabels(150, 80, 3))
    assertTrue(WidgetSizing.showActionLabels(250, 80, 3))
    assertFalse(WidgetSizing.showActionLabels(250, 50, 3))
  }

  @Test
  fun textIsShortAndStable() {
    assertEquals("410 MB", WidgetText.memory(419L shl 20))
    assertEquals("1.4 GB", WidgetText.memory(1500L shl 20))
    assertEquals("Port 8123", WidgetText.port("http://127.0.0.1:8123/"))
    assertEquals("127.0.0.1:8123 · python3", WidgetText.webServer("http://127.0.0.1:8123/", "/usr/bin/python3 -m http.server 8123"))
  }
}
