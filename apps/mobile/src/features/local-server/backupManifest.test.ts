import { describe, expect, it } from "vite-plus/test";

import {
  describeBackup,
  maintenanceOutcome,
  maintenanceProgress,
  parseBackupManifest,
} from "./backupManifest";
import type { MaintenanceSnapshot } from "./localServerModule";

const snapshot = (overrides: Partial<MaintenanceSnapshot>): MaintenanceSnapshot => ({
  operation: "backup",
  state: "running",
  done: 0,
  total: 0,
  detail: "",
  message: null,
  fileBytes: 0,
  ...overrides,
});

describe("parseBackupManifest", () => {
  it("reads the fields the dialog shows and tolerates missing ones", () => {
    const manifest = parseBackupManifest(
      JSON.stringify({
        uri: "content://x",
        appVersion: "2.2.0",
        createdAt: "2026-11-08T03:12:00Z",
        bytes: 2_000_000_000,
        fileBytes: 700_000_000,
        contents: ["Private projects", 3],
      }),
    );
    expect(manifest.contents).toEqual(["Private projects"]);
    expect(manifest.bytes).toBe(2_000_000_000);
    expect(parseBackupManifest("{}")).toMatchObject({ appVersion: "unknown", bytes: -1 });
  });
});

describe("describeBackup", () => {
  it("names the version, sizes and contents", () => {
    const text = describeBackup(
      parseBackupManifest(
        JSON.stringify({
          appVersion: "2.2.0",
          createdAt: "not a date",
          bytes: 3 * 1024 ** 3,
          fileBytes: 1024 ** 3,
          contents: ["Linux", "Private projects"],
        }),
      ),
    );
    expect(text).toBe(
      "Made at an unknown time by app version 2.2.0 (1.0 GB file, 3.0 GB unpacked). Holds: Linux, Private projects.",
    );
  });
});

describe("maintenanceProgress", () => {
  it("is indeterminate until the total is known", () => {
    expect(maintenanceProgress(snapshot({ detail: "Measuring" }))).toEqual({
      fraction: undefined,
      label: "Measuring",
    });
  });

  it("shows the share done, capped at the total", () => {
    expect(maintenanceProgress(snapshot({ done: 512 * 1024 ** 2, total: 1024 ** 3 }))).toEqual({
      fraction: 0.5,
      label: "50% · 512 MB of 1.0 GB",
    });
    expect(maintenanceProgress(snapshot({ done: 5, total: 4 })).fraction).toBe(1);
  });
});

describe("maintenanceOutcome", () => {
  it("says what happened and that nothing changed on failure", () => {
    expect(maintenanceOutcome(snapshot({}))).toBeNull();
    expect(
      maintenanceOutcome(
        snapshot({
          state: "done",
          message: "Downloads/x.tar.gz",
          fileBytes: 1024 ** 3,
          total: 3 * 1024 ** 3,
        }),
      ),
    ).toBe(
      "Backup saved to Downloads/x.tar.gz (1.0 GB, 3.0 GB unpacked). It holds Claude Code's sign-in: keep it private.",
    );
    expect(
      maintenanceOutcome(snapshot({ state: "failed", operation: "restore", message: "No space." })),
    ).toBe("Restore failed: No space. The environment was not changed.");
    expect(maintenanceOutcome(snapshot({ state: "cancelled" }))).toBe(
      "Backup cancelled. Nothing was saved.",
    );
  });
});
