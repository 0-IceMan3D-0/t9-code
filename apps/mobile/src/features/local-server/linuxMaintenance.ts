import { useSyncExternalStore } from "react";
import type { AlertButton } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { describeBackup, parseBackupManifest } from "./backupManifest";
import {
  getLocalServerStatus,
  localServer,
  subscribeLocalServerStatus,
  type MaintenanceSnapshot,
} from "./localServerModule";

let snapshot: MaintenanceSnapshot | null = localServer?.getMaintenance() ?? null;
const listeners = new Set<() => void>();

function publish(next: MaintenanceSnapshot | null) {
  snapshot = next;
  for (const listener of listeners) listener();
}

localServer?.addListener("onMaintenance", publish);

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useLinuxMaintenance(): MaintenanceSnapshot | null {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function dismissMaintenanceResult(): void {
  localServer?.clearMaintenance();
  publish(null);
}

export function cancelMaintenance(): void {
  localServer?.cancelMaintenance();
}

function ask(title: string, message: string, buttons: ReadonlyArray<AlertButton>) {
  return new Promise<string | null>((resolve) => {
    Dialog.alert(
      title,
      message,
      buttons.map((button) => ({ ...button, onPress: () => resolve(button.text ?? null) })),
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function showError(title: string, cause: unknown) {
  // A job that started reports its own failure on This phone; this covers refusals before it.
  if (snapshot?.state === "failed") return;
  Dialog.alert(title, errorMessage(cause));
}

const isServerActive = () => {
  const state = getLocalServerStatus()?.state;
  return state === "running" || state === "starting" || state === "installing";
};

function waitUntilStopped(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      if (isServerActive()) return false;
      unsubscribe();
      clearTimeout(timer);
      resolve(true);
      return true;
    };
    const unsubscribe = subscribeLocalServerStatus(check);
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, 30_000);
    check();
  });
}

/** Backups and restores need a quiet environment, so they offer to stop the server first. */
async function stopServerFor(action: string): Promise<boolean> {
  if (!isServerActive()) return true;
  const choice = await ask(
    "Stop the built-in server?",
    `${action} needs the server stopped, so files do not change halfway. Agents running on This phone stop too.`,
    [{ text: "Cancel", style: "cancel" }, { text: "Stop server" }],
  );
  if (choice !== "Stop server") return false;
  localServer?.stop();
  if (await waitUntilStopped()) return true;
  Dialog.alert("The server did not stop", "Try again in a moment.");
  return false;
}

export const BACKUP_EXCLUDED =
  "Left out to save space: /tmp, apt's downloaded packages, npm's download cache, /root/.cache and the shared project folder.";

export async function backUpLinux(): Promise<void> {
  const server = localServer;
  if (!server || !(await stopServerFor("A backup"))) return;
  const choice = await ask(
    "Back up Linux",
    `Saves Linux with its installed packages, private projects, threads on This phone, and Claude Code's sign-in in one file. ${BACKUP_EXCLUDED}\n\nThe file holds your Claude sign-in and any SSH keys. Keep it private: anyone with it can use your Claude account.`,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Choose location" },
      { text: "Save to Downloads" },
    ],
  );
  if (choice !== "Choose location" && choice !== "Save to Downloads") return;
  try {
    await server.backupLinux(choice === "Save to Downloads" ? "downloads" : "choose");
  } catch (cause) {
    showError("Backup failed", cause);
  }
}

export async function restoreLinux(): Promise<void> {
  const server = localServer;
  if (!server || !(await stopServerFor("Restoring"))) return;
  let manifestJson: string | null;
  try {
    manifestJson = await server.pickBackup();
  } catch (cause) {
    Dialog.alert("Can't use this file", errorMessage(cause));
    return;
  }
  if (manifestJson === null) return;
  const manifest = parseBackupManifest(manifestJson);
  const choice = await ask(
    "Restore this backup?",
    `${describeBackup(manifest)}\n\nIt replaces the Linux environment on this phone, with its projects, threads and Claude sign-in. Open Linux shells close. Projects in the shared folder are not in backups and stay as they are. If anything fails, the current environment stays.`,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Restore", style: "destructive" },
    ],
  );
  if (choice !== "Restore") return;
  try {
    await server.restoreLinux(manifest.uri);
  } catch (cause) {
    showError("Restore failed", cause);
  }
}

export async function resetLinux(): Promise<void> {
  const server = localServer;
  if (!server || !(await stopServerFor("Resetting"))) return;
  const choice = await ask(
    "Reset Linux?",
    "Downloads and sets up a fresh Linux, about 500 MB, then starts the server.\n\nKept: private projects, Claude Code's sign-in and settings, threads on This phone, git settings, SSH keys and adb keys.\n\nLost: packages you installed with apt or npm, and other files in Linux, including the rest of /root.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Reset", style: "destructive" },
    ],
  );
  if (choice !== "Reset") return;
  try {
    await server.resetLinux();
  } catch (cause) {
    Dialog.alert("Reset failed", errorMessage(cause));
  }
}

/** Deleting cannot be undone, so the dialog offers a backup first. */
export async function confirmDeleteEnvironment(onDelete: () => void): Promise<void> {
  const choice = await ask(
    "Delete environment?",
    "This deletes Linux, Claude Code's sign-in, threads on This phone and every project in private storage. A backup lets you restore them later.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Back up first" },
      { text: "Delete", style: "destructive" },
    ],
  );
  if (choice === "Back up first") await backUpLinux();
  if (choice === "Delete") onDelete();
}
