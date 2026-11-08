import { isLiveSubagentShell, type OrchestrationV2ThreadShell } from "@t3tools/contracts";

export interface LocalThreadWork {
  readonly working: number;
  readonly needsYou: number;
}

/** What on the built-in server would end if it stopped now; deleted threads never resume. */
export function summarizeLocalThreadWork(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): LocalThreadWork {
  let working = 0;
  let needsYou = 0;
  for (const thread of threads) {
    if (thread.deletedAt !== null) continue;
    if (thread.pendingRuntimeRequest !== null) needsYou += 1;
    else if (isLiveSubagentShell(thread)) working += 1;
  }
  return { working, needsYou };
}
