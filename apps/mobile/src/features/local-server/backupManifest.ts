import { formatBytes } from "../../lib/formatBytes";
import type { MaintenanceSnapshot } from "./localServerModule";

export interface BackupManifest {
  readonly uri: string;
  readonly appVersion: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly fileBytes: number;
  readonly contents: ReadonlyArray<string>;
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** The native side already checked the format; this only shapes what the dialog shows. */
export function parseBackupManifest(json: string): BackupManifest {
  const value = JSON.parse(json) as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  const number = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : -1);
  return {
    uri: text("uri"),
    appVersion: text("appVersion") || "unknown",
    createdAt: text("createdAt"),
    bytes: number("bytes"),
    fileBytes: number("fileBytes"),
    contents: strings(value.contents),
  };
}

export function describeBackup(manifest: BackupManifest, locale?: string): string {
  const created = new Date(manifest.createdAt);
  const when = Number.isNaN(created.getTime())
    ? "at an unknown time"
    : `on ${created.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}`;
  const size =
    manifest.fileBytes > 0
      ? `${formatBytes(manifest.fileBytes)} file, ${formatBytes(Math.max(manifest.bytes, 0))} unpacked`
      : `${formatBytes(Math.max(manifest.bytes, 0))} unpacked`;
  const contents = manifest.contents.length > 0 ? ` Holds: ${manifest.contents.join(", ")}.` : "";
  return `Made ${when} by app version ${manifest.appVersion} (${size}).${contents}`;
}

export function maintenanceProgress(snapshot: MaintenanceSnapshot): {
  readonly fraction: number | undefined;
  readonly label: string;
} {
  if (snapshot.total <= 0) {
    return { fraction: undefined, label: snapshot.detail || "Preparing" };
  }
  const fraction = Math.min(1, snapshot.done / snapshot.total);
  const amount =
    snapshot.operation === "backup"
      ? `${formatBytes(snapshot.done)} of ${formatBytes(snapshot.total)}`
      : `${formatBytes(snapshot.done)} of ${formatBytes(snapshot.total)} read`;
  return { fraction, label: `${Math.floor(fraction * 100)}% · ${amount}` };
}

export function maintenanceOutcome(snapshot: MaintenanceSnapshot): string | null {
  const backup = snapshot.operation === "backup";
  const reason = (snapshot.message ?? "unknown error").replace(/\.$/, "");
  switch (snapshot.state) {
    case "running":
      return null;
    case "done":
      return backup
        ? `Backup saved to ${snapshot.message ?? "the chosen file"} (${formatBytes(snapshot.fileBytes)}, ${formatBytes(snapshot.total)} unpacked). It holds Claude Code's sign-in: keep it private.`
        : "Restored. Start the server to use it.";
    case "cancelled":
      return backup
        ? "Backup cancelled. Nothing was saved."
        : "Restore cancelled. Nothing changed.";
    case "failed":
      return backup
        ? `Backup failed: ${reason}. Nothing was saved.`
        : `Restore failed: ${reason}. The environment was not changed.`;
  }
}
