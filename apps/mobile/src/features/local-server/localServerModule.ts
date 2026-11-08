import { requireOptionalNativeModule, type EventSubscription } from "expo";
import Constants from "expo-constants";
import { useSyncExternalStore } from "react";

export type LocalServerState =
  | "notInstalled"
  | "installing"
  | "stopped"
  | "starting"
  | "running"
  | "failed";

export interface LocalServerStatus {
  readonly state: LocalServerState;
  readonly detail: string;
  readonly progress: number;
  readonly port: number;
  readonly startOnAppOpen: boolean;
  readonly sharedStorage: boolean;
  readonly sharedStorageGranted: boolean;
}

export interface UsbDevice {
  readonly name: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly label: string;
  readonly allowed: boolean;
}

/** A TCP socket a process in Linux is listening on, as the native side tracks it. */
export interface DevServerListener {
  readonly port: number;
  readonly address: string;
  readonly url: string;
  readonly pid: number;
  readonly command: string;
  /** Milliseconds since boot. */
  readonly since: number;
}

export interface BatteryState {
  readonly optimized: boolean;
  readonly hintDismissed: boolean;
}

export interface MaintenanceSnapshot {
  readonly operation: "backup" | "restore";
  readonly state: "running" | "done" | "failed" | "cancelled";
  readonly done: number;
  readonly total: number;
  readonly detail: string;
  readonly message: string | null;
  /** Size of the saved backup file, once a backup is done. */
  readonly fileBytes: number;
}

export interface HealthSample {
  /** Milliseconds since boot. */
  readonly at: number;
  readonly rssBytes: number;
  readonly cpuTicks: number;
  readonly ticksPerSecond: number;
  readonly cores: number;
  readonly processes: number;
  readonly totalMemory: number;
  readonly availableMemory: number;
  readonly warning: "deviceLow" | "treeLarge" | null;
}

export interface StorageSample {
  readonly linuxBytes: number;
  readonly projectBytes: number;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

interface LocalServerNativeModule {
  getStatus(): LocalServerStatus;
  listUsbDevices(): ReadonlyArray<UsbDevice>;
  listDevServers(): ReadonlyArray<DevServerListener>;
  allowUsbDevice(name: string): void;
  start(): void;
  stop(): void;
  takePairingUrl(): string | null;
  setStartOnAppOpen(value: boolean): void;
  setSharedStorage(value: boolean): void;
  /** The tile and launcher shortcuts open screens through the app's deep links. */
  setAppScheme(scheme: string): void;
  getBatteryState(): BatteryState;
  /** Returns which screen opened: "prompt", "list", "details" or "none". */
  openBatterySettings(): string;
  dismissBatteryHint(): void;
  readLog(): Promise<string>;
  reset(): Promise<void>;
  sampleHealth(): Promise<HealthSample>;
  measureStorage(): Promise<StorageSample>;
  getMaintenance(): MaintenanceSnapshot | null;
  clearMaintenance(): void;
  cancelMaintenance(): void;
  /** Resolves with the result as JSON, or null when the picker or the backup was cancelled. */
  backupLinux(destination: "downloads" | "choose"): Promise<string | null>;
  /** Resolves with the chosen backup's manifest as JSON, or null when nothing was picked. */
  pickBackup(): Promise<string | null>;
  restoreLinux(uri: string): Promise<string | null>;
  resetLinux(): Promise<void>;
  requestStorageAccess(): Promise<unknown>;
  claudeLoggedIn(): Promise<boolean>;
  startClaudeLogin(): Promise<string>;
  submitClaudeCode(code: string): Promise<number>;
  waitForClaudeLogin(): Promise<number>;
  cancelClaudeLogin(): void;
  openShell(cols: number, rows: number): Promise<string>;
  writeShell(data: string): void;
  resizeShell(cols: number, rows: number): void;
  saveToDownloads(id: string, url: string, fileName: string): Promise<string>;
  addListener(event: "onStatus", listener: (status: LocalServerStatus) => void): EventSubscription;
  addListener(
    event: "onShellOutput",
    listener: (event: { readonly data: string }) => void,
  ): EventSubscription;
  addListener(event: "onShellExit", listener: () => void): EventSubscription;
  addListener(
    event: "onDevServers",
    listener: (event: { readonly servers: ReadonlyArray<DevServerListener> }) => void,
  ): EventSubscription;
  addListener(
    event: "onMaintenance",
    listener: (snapshot: MaintenanceSnapshot) => void,
  ): EventSubscription;
  addListener(
    event: "onUsbDevices",
    listener: (event: { readonly devices: ReadonlyArray<UsbDevice> }) => void,
  ): EventSubscription;
  addListener(
    event: "onDownloadProgress",
    listener: (event: {
      readonly id: string;
      readonly written: number;
      readonly total: number;
    }) => void,
  ): EventSubscription;
}

export const localServer = requireOptionalNativeModule<LocalServerNativeModule>("T3LocalServer");

const scheme = Constants.expoConfig?.scheme;
localServer?.setAppScheme((Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code");

// One store for every screen. Option writes change native state without a native event, so the
// writer refreshes here and every subscriber hears it, not only the next screen that mounts.
let snapshot: LocalServerStatus | null = localServer?.getStatus() ?? null;
const statusListeners = new Set<() => void>();

function publishStatus(next: LocalServerStatus | null): void {
  snapshot = next;
  for (const listener of statusListeners) listener();
}

localServer?.addListener("onStatus", publishStatus);

export function refreshLocalServerStatus(): void {
  publishStatus(localServer?.getStatus() ?? null);
}

export function getLocalServerStatus(): LocalServerStatus | null {
  return snapshot;
}

export function subscribeLocalServerStatus(onChange: () => void) {
  statusListeners.add(onChange);
  return () => {
    statusListeners.delete(onChange);
  };
}

export function useLocalServerStatus(): LocalServerStatus | null {
  return useSyncExternalStore(subscribeLocalServerStatus, getLocalServerStatus);
}

let usbDevices: ReadonlyArray<UsbDevice> = localServer?.listUsbDevices() ?? [];

function subscribeUsb(onChange: () => void) {
  const subscription = localServer?.addListener("onUsbDevices", (event) => {
    usbDevices = event.devices;
    onChange();
  });
  return () => subscription?.remove();
}

export function useUsbDevices(): ReadonlyArray<UsbDevice> {
  return useSyncExternalStore(subscribeUsb, () => usbDevices);
}
