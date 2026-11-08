import { RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeRawThreadShell } from "../../test-fixtures";
import { summarizeLocalThreadWork } from "./autoStopWork";

const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const shell = makeRawThreadShell;

describe("summarizeLocalThreadWork", () => {
  it("counts running and waiting threads, not settled or deleted ones", () => {
    const request = {
      id: RuntimeRequestId.make("request-1"),
      kind: "command",
      createdAt: at,
    } as const;
    expect(
      summarizeLocalThreadWork([
        shell({ status: "running" }),
        shell({ status: "queued" }),
        shell({ status: "completed" }),
        shell({ status: "idle" }),
        shell({ status: "waiting", pendingRuntimeRequest: request }),
        shell({ status: "running", deletedAt: at }),
      ]),
    ).toEqual({ working: 2, needsYou: 1 });
  });
});
