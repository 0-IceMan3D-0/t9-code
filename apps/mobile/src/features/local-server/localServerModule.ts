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
  readonly startAtBoot: boolean;
  readonly sharedStorage: boolean;
  readonly sharedStorageGranted: boolean;
}

export type TermuxState = "notInstalled" | "installing" | "ready" | "failed";

export interface TermuxStatus {
  readonly state: TermuxState;
  readonly detail: string;
  readonly progress: number;
  readonly sessions: ReadonlyArray<number>;
}

interface LocalServerNativeModule {
  getStatus(): LocalServerStatus;
  start(): void;
  stop(): void;
  takePairingUrl(): string | null;
  setStartAtBoot(value: boolean): void;
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
  getTermuxStatus(): TermuxStatus;
  installTermux(): void;
  resetTermux(): Promise<void>;
  createTermuxSession(cols: number, rows: number): Promise<number>;
  termuxHistory(id: number): string;
  writeTermux(id: number, data: string): void;
  resizeTermux(id: number, cols: number, rows: number): void;
  closeTermuxSession(id: number): void;
  addListener(event: "onStatus", listener: (status: LocalServerStatus) => void): EventSubscription;
  addListener(
    event: "onShellOutput",
    listener: (event: { readonly data: string }) => void,
  ): EventSubscription;
  addListener(event: "onShellExit", listener: () => void): EventSubscription;
  addListener(event: "onTermuxStatus", listener: (status: TermuxStatus) => void): EventSubscription;
  addListener(
    event: "onTermuxOutput",
    listener: (event: { readonly id: number; readonly data: string }) => void,
  ): EventSubscription;
  addListener(
    event: "onTermuxExit",
    listener: (event: { readonly id: number }) => void,
  ): EventSubscription;
}

export const localServer = requireOptionalNativeModule<LocalServerNativeModule>("T3LocalServer");

let snapshot: LocalServerStatus | null = localServer?.getStatus() ?? null;

export function refreshLocalServerStatus(): void {
  snapshot = localServer?.getStatus() ?? null;
}

function subscribe(onChange: () => void) {
  const subscription = localServer?.addListener("onStatus", (status) => {
    snapshot = status;
    onChange();
  });
  return () => subscription?.remove();
}

export function useLocalServerStatus(): LocalServerStatus | null {
  return useSyncExternalStore(subscribe, () => snapshot);
}

let termuxSnapshot: TermuxStatus | null = localServer?.getTermuxStatus() ?? null;

function subscribeTermux(onChange: () => void) {
  const subscription = localServer?.addListener("onTermuxStatus", (status) => {
    termuxSnapshot = status;
    onChange();
  });
  return () => subscription?.remove();
}

export function useTermuxStatus(): TermuxStatus | null {
  return useSyncExternalStore(subscribeTermux, () => termuxSnapshot);
}
