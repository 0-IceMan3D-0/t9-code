import { requireOptionalNativeModule, type EventSubscription } from "expo";
import Constants from "expo-constants";
import { useSyncExternalStore } from "react";

import type { OllamaState, PhoneModelsState } from "./localModels";

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
  readonly stopOnLeave: boolean;
  /** Minutes after leaving the app before "Stop when I leave the app" stops the server. */
  readonly stopAfterMinutes: number;
  readonly sharedStorage: boolean;
  readonly sharedStorageGranted: boolean;
}

/** Agent CLIs the app installs in Linux. */
export type AgentToolId = "opencode" | "claude";

export interface AgentToolState {
  readonly installed: boolean;
  readonly version: string | null;
  readonly busy: string | null;
  readonly detail: string | null;
  readonly error: string | null;
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

export interface LinuxShellInfo {
  readonly id: string;
  /** The newest program started from the shell, or null while it waits at the prompt. */
  readonly command: string | null;
  /** The last window title set, such as bash's "root@localhost: ~/app". */
  readonly title: string | null;
  readonly busy: boolean;
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

/** Linux's own files, or the phone's shared storage. */
export type LocalFilesVolume = "linux" | "phone";

interface LocalServerNativeModule {
  getStatus(): LocalServerStatus;
  listUsbDevices(): ReadonlyArray<UsbDevice>;
  listDevServers(): ReadonlyArray<DevServerListener>;
  allowUsbDevice(name: string): void;
  start(): void;
  stop(): void;
  takePairingUrl(): string | null;
  setStartOnAppOpen(value: boolean): void;
  setStopOnLeave(value: boolean): void;
  setStopAfterMinutes(minutes: number): void;
  /** JSON of `{ known, working, needsYou }` for the built-in server's threads. */
  reportThreadWork(json: string): void;
  setSharedStorage(value: boolean): void;
  /** The activity that starts or stops the server for a launcher shortcut, and its actions. */
  serverSwitchTarget(): {
    readonly className: string;
    readonly start: string;
    readonly stop: string;
  };
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
  /** Ids of the open Linux shells, oldest first. */
  listShells(): ReadonlyArray<string>;
  describeShells(): Promise<ReadonlyArray<LinuxShellInfo>>;
  /** Starts a shell and resolves with its id. */
  openShell(cols: number, rows: number): Promise<string>;
  /** Output so far, or null when the shell has ended. */
  shellHistory(id: string): Promise<string | null>;
  /** Ends the shell and everything started in it. */
  closeShell(id: string): Promise<void>;
  writeShell(id: string, data: string): void;
  resizeShell(id: string, cols: number, rows: number): void;
  saveToDownloads(id: string, url: string, fileName: string): Promise<string>;
  filesStorageGranted(): boolean;
  /** A file:// URI for previews; Linux symlinks are resolved inside Linux. */
  filesUri(volume: LocalFilesVolume, path: string): string;
  /** JSON of a FilesystemListDirectoryResult. */
  filesList(volume: LocalFilesVolume, path: string): Promise<string>;
  filesStat(volume: LocalFilesVolume, path: string): Promise<string>;
  filesCreateDirectory(volume: LocalFilesVolume, path: string): Promise<void>;
  filesCreateFile(volume: LocalFilesVolume, path: string): Promise<void>;
  filesCopy(
    fromVolume: LocalFilesVolume,
    from: string,
    toVolume: LocalFilesVolume,
    to: string,
  ): Promise<void>;
  filesMove(
    fromVolume: LocalFilesVolume,
    from: string,
    toVolume: LocalFilesVolume,
    to: string,
  ): Promise<void>;
  filesDelete(volume: LocalFilesVolume, paths: ReadonlyArray<string>): Promise<void>;
  /** JSON of `{ contents, byteLength, truncated, binary, modifiedAt }`. */
  filesReadText(volume: LocalFilesVolume, path: string, maxBytes: number): Promise<string>;
  /** Rejects with ERR_CHANGED when the file's modification time is not `expectedModifiedAt`. */
  filesWriteText(
    volume: LocalFilesVolume,
    path: string,
    contents: string,
    expectedModifiedAt: number | null,
  ): Promise<void>;
  filesReadBase64(
    volume: LocalFilesVolume,
    path: string,
    offset: number,
    length: number,
  ): Promise<string>;
  filesImport(volume: LocalFilesVolume, path: string, sourceUri: string): Promise<void>;
  /** Resolves with the saved file's name. */
  filesSaveToDownloads(volume: LocalFilesVolume, path: string): Promise<string>;
  filesOpen(volume: LocalFilesVolume, path: string, share: boolean): Promise<void>;
  /** JSON of `{ entries, truncated }`; each entry also carries its `path`. */
  filesSearch(
    volume: LocalFilesVolume,
    path: string,
    query: string,
    limit: number,
  ): Promise<string>;
  /** JSON of `{ byteLength, files, folders, complete }`. */
  filesSize(volume: LocalFilesVolume, path: string): Promise<string>;
  /** Git identity and SSH key state in Linux, as JSON. */
  gitStatus(): Promise<string>;
  /** An empty value removes that setting. */
  setGitIdentity(name: string, email: string): Promise<void>;
  installGitTools(): Promise<void>;
  /** Rejects with ERR_KEY_EXISTS unless `overwrite` is set. */
  createSshKey(overwrite: boolean): Promise<void>;
  deleteSshKey(): Promise<void>;
  /** `ssh -T git@github.com`, as JSON with exitCode and output. */
  testGitHub(): Promise<string>;
  ollamaState(): OllamaState;
  installOllama(): void;
  /** Removes Ollama and every downloaded model. */
  uninstallOllama(): void;
  pullOllamaModel(name: string): void;
  deleteOllamaModel(name: string): void;
  phoneModelsState(): PhoneModelsState;
  downloadPhoneModel(id: string): void;
  cancelPhoneModelDownload(): void;
  deletePhoneModel(id: string): void;
  agentToolState(id: AgentToolId): AgentToolState;
  /** Each resolves once npm is done; progress and errors arrive through onAgentTool. */
  installAgentTool(id: AgentToolId): Promise<void>;
  updateAgentTool(id: AgentToolId): Promise<void>;
  removeAgentTool(id: AgentToolId): Promise<void>;
  addListener(
    event: "onAgentTool",
    listener: (state: AgentToolState & { readonly id: AgentToolId }) => void,
  ): EventSubscription;
  addListener(event: "onOllama", listener: (state: OllamaState) => void): EventSubscription;
  addListener(
    event: "onPhoneModels",
    listener: (state: PhoneModelsState) => void,
  ): EventSubscription;
  addListener(event: "onStatus", listener: (status: LocalServerStatus) => void): EventSubscription;
  addListener(
    event: "onShellOutput",
    listener: (event: { readonly id: string; readonly data: string }) => void,
  ): EventSubscription;
  addListener(
    event: "onShellExit",
    listener: (event: { readonly id: string }) => void,
  ): EventSubscription;
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
    event: "onGitSetup",
    listener: (event: {
      readonly stage: "update" | "install";
      readonly percent: number;
      readonly detail: string;
    }) => void,
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

let ollama: OllamaState | null = localServer?.ollamaState() ?? null;

function subscribeOllama(onChange: () => void) {
  const subscription = localServer?.addListener("onOllama", (next) => {
    ollama = next;
    onChange();
  });
  return () => subscription?.remove();
}

export function useOllama(): OllamaState | null {
  return useSyncExternalStore(subscribeOllama, () => ollama);
}

let phoneModels: PhoneModelsState | null = localServer?.phoneModelsState() ?? null;

function subscribePhoneModels(onChange: () => void) {
  const subscription = localServer?.addListener("onPhoneModels", (next) => {
    phoneModels = next;
    onChange();
  });
  return () => subscription?.remove();
}

export function usePhoneModels(): PhoneModelsState | null {
  return useSyncExternalStore(subscribePhoneModels, () => phoneModels);
}

const agentTools: Record<AgentToolId, AgentToolState | null> = {
  opencode: localServer?.agentToolState("opencode") ?? null,
  claude: localServer?.agentToolState("claude") ?? null,
};

function subscribeAgentTools(onChange: () => void) {
  const subscription = localServer?.addListener("onAgentTool", ({ id, ...state }) => {
    agentTools[id] = state;
    onChange();
  });
  return () => subscription?.remove();
}

export function useAgentTool(id: AgentToolId): AgentToolState | null {
  return useSyncExternalStore(subscribeAgentTools, () => agentTools[id]);
}
