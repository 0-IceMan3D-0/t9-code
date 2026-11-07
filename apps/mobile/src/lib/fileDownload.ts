import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { localServer } from "../features/local-server/localServerModule";
import { refreshAssetUrl } from "../state/assets";
import { downloadAndShareAttachment } from "./attachmentDownload";
import { uuidv4 } from "./uuid";

const MEDIA_STORE_DOWNLOADS_SDK = 29;

export type FileDownloadNotice =
  | { readonly tone: "busy"; readonly name: string; readonly progress: number | null }
  | { readonly tone: "success"; readonly name: string }
  | { readonly tone: "danger"; readonly name: string; readonly message: string };

let notice: FileDownloadNotice | null = null;
const listeners = new Set<() => void>();

function publish(next: FileDownloadNotice | null) {
  notice = next;
  listeners.forEach((listener) => listener());
}

export function dismissFileDownloadNotice() {
  publish(null);
}

export function useFileDownloadNotice() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notice,
  );
}

async function saveWithMediaStore(url: string, name: string): Promise<string> {
  const server = localServer!;
  const id = uuidv4();
  const progress = server.addListener("onDownloadProgress", (event) => {
    if (event.id !== id) return;
    publish({
      tone: "busy",
      name,
      progress: event.total > 0 ? event.written / event.total : null,
    });
  });
  try {
    return await server.saveToDownloads(id, url, name);
  } finally {
    progress.remove();
  }
}

/** Android 9 and older have no MediaStore Downloads, and iOS saves through the share sheet. */
export async function downloadFile(input: {
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly name: string;
}): Promise<void> {
  const { name } = input;
  publish({ tone: "busy", name, progress: null });
  try {
    const url = await refreshAssetUrl(input.environmentId, input.resource);
    if (url === null) throw new Error("The server did not allow this file to be read.");
    if (Platform.OS === "android" && Platform.Version >= MEDIA_STORE_DOWNLOADS_SDK && localServer) {
      publish({ tone: "success", name: await saveWithMediaStore(url, name) });
      return;
    }
    await downloadAndShareAttachment({
      url,
      attachment: { name, mimeType: "application/octet-stream" },
      signal: new AbortController().signal,
    });
    publish(null);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    publish({ tone: "danger", name, message });
  }
}
