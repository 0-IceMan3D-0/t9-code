import { requireOptionalNativeModule, type EventSubscription } from "expo";
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

interface LocalServerNativeModule {
  getStatus(): LocalServerStatus;
  listUsbDevices(): ReadonlyArray<UsbDevice>;
  allowUsbDevice(name: string): void;
  start(): void;
  stop(): void;
  takePairingUrl(): string | null;
  setStartOnAppOpen(value: boolean): void;
  setSharedStorage(value: boolean): void;
  readLog(): Promise<string>;
  reset(): Promise<void>;
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

function subscribe(onChange: () => void) {
  statusListeners.add(onChange);
  return () => {
    statusListeners.delete(onChange);
  };
}

export function useLocalServerStatus(): LocalServerStatus | null {
  return useSyncExternalStore(subscribe, () => snapshot);
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
