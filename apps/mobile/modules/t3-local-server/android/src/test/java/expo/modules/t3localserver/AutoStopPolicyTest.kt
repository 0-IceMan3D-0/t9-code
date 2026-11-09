package expo.modules.t3localserver

import expo.modules.t3localserver.AutoStopPolicy.GRACE_MILLIS
import expo.modules.t3localserver.AutoStopPolicy.SETTLE_MILLIS
import org.junit.Assert.assertEquals
import org.junit.Test

class AutoStopPolicyTest {
  private val left = 1_000L

  private fun decide(now: Long, work: AutoStopWork = AutoStopWork(), clearedAt: Long? = null, armed: Boolean = true) =
    AutoStopPolicy.decide(armed, now, left, clearedAt, work)

  @Test
  fun idleWhileTheAppIsOpenOrDisarmed() {
    assertEquals(AutoStopDecision.Idle, AutoStopPolicy.decide(true, left + GRACE_MILLIS, null, null, AutoStopWork()))
    assertEquals(AutoStopDecision.Idle, decide(left + GRACE_MILLIS, armed = false))
  }

  @Test
  fun countsDownTheGraceThenStops() {
    assertEquals(AutoStopDecision.Countdown(left + GRACE_MILLIS), decide(left + 5_000))
    assertEquals(AutoStopDecision.Stop, decide(left + GRACE_MILLIS))
    val custom = 30 * 60_000L
    assertEquals(AutoStopDecision.Countdown(left + custom), AutoStopPolicy.decide(true, left + GRACE_MILLIS, left, null, AutoStopWork(), custom))
    assertEquals(AutoStopDecision.Stop, AutoStopPolicy.decide(true, left + custom, left, null, AutoStopWork(), custom))
  }

  @Test
  fun anyBlockerWaitsEvenAfterTheGrace() {
    val blockers = listOf(
      AutoStopWork(threadsWorking = 1),
      AutoStopWork(threadsNeedingYou = 1),
      AutoStopWork(threadsUnknown = true),
      AutoStopWork(busyShells = 1),
      AutoStopWork(webServerPorts = listOf(5173)),
      AutoStopWork(maintenance = true),
      AutoStopWork(serverStarting = true),
    )
    for (work in blockers) {
      assert(decide(left + 10 * GRACE_MILLIS, work) is AutoStopDecision.Waiting) { work.toString() }
    }
  }

  @Test
  fun settlesAfterWorkEndsPastTheGrace() {
    val cleared = left + 5 * GRACE_MILLIS
    assertEquals(AutoStopDecision.Countdown(cleared + SETTLE_MILLIS), decide(cleared, clearedAt = cleared))
    assertEquals(AutoStopDecision.Stop, decide(cleared + SETTLE_MILLIS, clearedAt = cleared))
  }

  @Test
  fun workEndingEarlyStillWaitsOutTheGrace() {
    val cleared = left + 1_000
    assertEquals(AutoStopDecision.Countdown(left + GRACE_MILLIS), decide(cleared + SETTLE_MILLIS, clearedAt = cleared))
  }

  @Test
  fun namesWhatItWaitsFor() {
    assertEquals("Will stop when 2 threads finish", AutoStopPolicy.waitingText(AutoStopWork(threadsWorking = 2)))
    assertEquals(
      "Will stop when the Linux shell finishes",
      AutoStopPolicy.waitingText(AutoStopWork(busyShells = 1)),
    )
    assertEquals(
      "Will stop when you answer 1 thread, 1 thread finishes and the web server on port 5173 stops",
      AutoStopPolicy.waitingText(
        AutoStopWork(threadsWorking = 1, threadsNeedingYou = 1, webServerPorts = listOf(5173)),
      ),
    )
  }
}
