package expo.modules.t3localserver

/** What still uses the built-in server, as far as the phone can tell. */
data class AutoStopWork(
  /** Threads on the built-in server running a turn, queued or holding background work. */
  val threadsWorking: Int = 0,
  /** Threads waiting on an approval or an answer: stopping would end the paused agent. */
  val threadsNeedingYou: Int = 0,
  /** The app has not seen the built-in server's threads, so it cannot tell. */
  val threadsUnknown: Boolean = false,
  /** Linux shell tabs with a program running beyond the idle shell. */
  val busyShells: Int = 0,
  /** Ports of web servers listening inside Linux. */
  val webServerPorts: List<Int> = emptyList(),
  val maintenance: Boolean = false,
  /** The server is still starting, so stopping now would waste the start. */
  val serverStarting: Boolean = false,
) {
  val blocked get() = reasons().isNotEmpty()

  /** Each thing still in use, as the end of "Will stop when …", most important first. */
  fun reasons(): List<String> = buildList {
    if (threadsNeedingYou > 0) add("you answer ${count(threadsNeedingYou, "thread")}")
    if (threadsWorking > 0) {
      add(if (threadsWorking == 1) "1 thread finishes" else "$threadsWorking threads finish")
    }
    if (threadsUnknown) add("the app can check the server's threads")
    if (busyShells > 0) {
      add(if (busyShells == 1) "the Linux shell finishes" else "$busyShells Linux shells finish")
    }
    when (webServerPorts.size) {
      0 -> Unit
      1 -> add("the web server on port ${webServerPorts[0]} stops")
      else -> add("${webServerPorts.size} web servers stop")
    }
    if (maintenance) add("the backup or restore finishes")
    if (serverStarting) add("the server has started")
  }

  private fun count(n: Int, noun: String) = if (n == 1) "1 $noun" else "$n ${noun}s"
}

sealed class AutoStopDecision {
  /** Not armed: the app is open, the option is off, "Keep running" was chosen or nothing runs. */
  object Idle : AutoStopDecision()

  data class Waiting(val text: String) : AutoStopDecision()

  /** Counting down to [stopAt], on the elapsed-realtime clock. */
  data class Countdown(val stopAt: Long) : AutoStopDecision()

  object Stop : AutoStopDecision()
}

/** The pure part of "Stop when I leave the app", so it can be tested without Android. */
object AutoStopPolicy {
  /** Long enough for a share sheet, a sign-in in the browser, a photo picker or a quick app switch. */
  const val GRACE_MILLIS = 120_000L

  /** After the last work ends, in case the agent or the person starts something right away. */
  const val SETTLE_MILLIS = 30_000L

  fun waitingText(work: AutoStopWork): String {
    val reasons = work.reasons()
    val joined = when (reasons.size) {
      0 -> ""
      1 -> reasons[0]
      else -> reasons.dropLast(1).joinToString(", ") + " and " + reasons.last()
    }
    return "Will stop when $joined"
  }

  /**
   * @param leftAt when the app left the foreground, or null while it is open.
   * @param clearedAt when the last work seen after leaving ended, or null when none was seen.
   */
  fun decide(
    armed: Boolean,
    now: Long,
    leftAt: Long?,
    clearedAt: Long?,
    work: AutoStopWork,
  ): AutoStopDecision {
    if (!armed || leftAt == null) return AutoStopDecision.Idle
    if (work.blocked) return AutoStopDecision.Waiting(waitingText(work))
    val stopAt = maxOf(leftAt + GRACE_MILLIS, clearedAt?.plus(SETTLE_MILLIS) ?: Long.MIN_VALUE)
    return if (now >= stopAt) AutoStopDecision.Stop else AutoStopDecision.Countdown(stopAt)
  }
}
