import { useAtomValue } from "@effect/atom-react";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  FilesystemOperationError,
  ThreadId,
  type EnvironmentId,
  type FilesystemDirectoryEntry,
  type FilesystemMutateInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";

import { downloadFile } from "../../lib/fileDownload";
import { appAtomRegistry } from "../../state/atom-registry";
import { refreshAssetUrl } from "../../state/assets";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { localServer, type LocalFilesVolume } from "../local-server/localServerModule";
import { explorerBasename, type ExplorerSeparator } from "./explorerPath";

/** Where an explorer screen reads files: a T3 server, or this phone's own storage directly. */
export type ExplorerTarget =
  | { readonly kind: "server"; readonly environmentId: EnvironmentId }
  | { readonly kind: "local"; readonly volume: LocalFilesVolume };

export interface ExplorerListing {
  readonly path: string;
  readonly parentPath: string | null;
  readonly homePath: string;
  readonly separator: ExplorerSeparator;
  readonly entries: ReadonlyArray<FilesystemDirectoryEntry>;
  readonly truncated: boolean;
  /** Servers older than `filesystem.listDirectory` can browse and preview but not change files. */
  readonly canManage: boolean;
}

export interface ExplorerTextFile {
  readonly contents: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  /** Set where saving can detect that the file changed since it was read. */
  readonly modifiedAt: number | null;
}

export interface ExplorerSearchResult extends FilesystemDirectoryEntry {
  readonly path: string;
}

export interface ExplorerBackend {
  readonly target: ExplorerTarget;
  /** Items copied or cut under one key can be pasted anywhere else under it. */
  readonly clipboardKey: string;
  readonly canWrite: boolean;
  readonly mutate: (input: FilesystemMutateInput) => Promise<void>;
  /** Copies or moves an item from another target with the same clipboard key. */
  readonly transfer: (input: {
    readonly mode: "copy" | "move";
    readonly from: ExplorerTarget;
    readonly fromPath: string;
    readonly to: string;
  }) => Promise<void>;
  readonly upload: (sourceUri: string, path: string) => Promise<void>;
  readonly download: (path: string) => Promise<string | null>;
  readonly readText: (path: string, maxBytes: number) => Promise<ExplorerTextFile>;
  readonly writeText: (
    path: string,
    contents: string,
    expectedModifiedAt: number | null,
  ) => Promise<void>;
  /** A URI the image, video and audio viewers can load. */
  readonly fileUri: (path: string) => Promise<string | null>;
  readonly openWith: ((path: string, share: boolean) => Promise<void>) | null;
  readonly search:
    | ((
        path: string,
        query: string,
      ) => Promise<{
        readonly entries: ReadonlyArray<ExplorerSearchResult>;
        readonly truncated: boolean;
      }>)
    | null;
  readonly folderSize:
    | ((path: string) => Promise<{
        readonly byteLength: number;
        readonly files: number;
        readonly folders: number;
        readonly complete: boolean;
      }>)
    | null;
  readonly readBase64: ((path: string, offset: number, length: number) => Promise<string>) | null;
}

const isOperationError = Schema.is(FilesystemOperationError);
// Absolute media-file paths are served without a thread lookup; the id only satisfies the schema.
const EXPLORER_THREAD_ID = ThreadId.make("file-explorer");
const LOCAL_CLIPBOARD_KEY = "local";

export function explorerTargetKey(target: ExplorerTarget) {
  return target.kind === "server" ? `server:${target.environmentId}` : `local:${target.volume}`;
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function directoryOf(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path.slice(0, 1) || "/" : path.slice(0, index);
}

async function utf8Base64(text: string) {
  const scratch = new File(Paths.cache, `t3-explorer-${Date.now()}.txt`);
  scratch.write(text);
  try {
    return await scratch.base64();
  } finally {
    scratch.delete();
  }
}

function requireLocalServer() {
  if (!localServer) throw new Error("Direct file access needs the Android app.");
  return localServer;
}

function useServerListing(environmentId: EnvironmentId | null, path: string) {
  const primary = useEnvironmentQuery(
    environmentId !== null
      ? filesystemEnvironment.listDirectory({ environmentId, input: { path } })
      : null,
  );
  // An older server rejects the unknown method; fall back to calls it has had for longer.
  const legacy =
    environmentId !== null && primary.failure !== null && !isOperationError(primary.failure);
  const browse = useEnvironmentQuery(
    legacy
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: /[\\/]$/.test(path) || path === "~" ? path : `${path}/` },
        })
      : null,
  );
  const legacyPath = browse.data?.parentPath ?? null;
  const legacyEntries = useEnvironmentQuery(
    legacy && legacyPath !== null
      ? projectEnvironment.listEntries({
          environmentId,
          input: { cwd: legacyPath, directoryPath: "" },
        })
      : null,
  );
  const refresh = () => {
    primary.refresh();
    if (legacy) {
      browse.refresh();
      legacyEntries.refresh();
    }
  };
  if (!legacy) {
    return {
      listing: primary.data === null ? null : { ...primary.data, canManage: true },
      error: primary.error,
      isPending: primary.isPending,
      refresh,
    };
  }
  const separator: ExplorerSeparator =
    legacyPath !== null && legacyPath.includes("\\") && !legacyPath.includes("/") ? "\\" : "/";
  const parent = legacyPath === null ? null : directoryOf(legacyPath);
  return {
    listing:
      legacyPath === null || legacyEntries.data === null
        ? null
        : {
            path: legacyPath,
            parentPath: parent === legacyPath ? null : parent,
            homePath: "~",
            separator,
            entries: legacyEntries.data.entries.map((entry) => ({
              name: entry.path,
              kind: entry.kind,
              symlink: false,
            })),
            truncated: legacyEntries.data.truncated,
            canManage: false,
          },
    error: browse.error ?? legacyEntries.error,
    isPending: primary.isPending || browse.isPending || legacyEntries.isPending,
    refresh,
  };
}

function useLocalListing(volume: LocalFilesVolume | null, path: string) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    readonly key: string;
    readonly listing: ExplorerListing | null;
    readonly error: string | null;
  } | null>(null);
  const key = JSON.stringify([volume, path, version]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads the folder from the phone's disk through the native module.
  useEffect(() => {
    if (volume === null) return;
    let live = true;
    requireLocalServer()
      .filesList(volume, path)
      .then((json) => {
        if (live) setState({ key, listing: { ...JSON.parse(json), canManage: true }, error: null });
      })
      .catch((cause: unknown) => {
        if (live) setState({ key, listing: null, error: errorMessage(cause) });
      });
    return () => {
      live = false;
    };
  }, [volume, path, key]);
  const current = state?.key === key ? state : null;
  // Keep the previous listing on screen while a refresh of the same folder loads.
  const shown =
    current ??
    (state && JSON.parse(state.key)[1] === path && JSON.parse(state.key)[0] === volume
      ? state
      : null);
  return {
    listing: shown?.listing ?? null,
    error: shown?.error ?? null,
    isPending: volume !== null && current === null,
    refresh: () => setVersion((value) => value + 1),
  };
}

export function useExplorerListing(target: ExplorerTarget | null, path: string) {
  const server = useServerListing(target?.kind === "server" ? target.environmentId : null, path);
  const local = useLocalListing(target?.kind === "local" ? target.volume : null, path);
  return target?.kind === "local" ? local : server;
}

function unwrap<A>(result: { readonly _tag: string; readonly value?: A }): A {
  if (result._tag === "Success") return result.value as A;
  if (isAtomCommandInterrupted(result as never)) throw new Error("Cancelled.");
  throw squashAtomCommandFailure(result as never);
}

function localBackend(volume: LocalFilesVolume): ExplorerBackend {
  const native = () => requireLocalServer();
  return {
    target: { kind: "local", volume },
    clipboardKey: LOCAL_CLIPBOARD_KEY,
    canWrite: true,
    mutate: async (input) => {
      switch (input._tag) {
        case "createDirectory":
          return native().filesCreateDirectory(volume, input.path);
        case "createFile":
          return native().filesCreateFile(volume, input.path);
        case "rename":
          return native().filesMove(volume, input.from, volume, input.to);
        case "copy":
          return native().filesCopy(volume, input.from, volume, input.to);
        case "delete":
          return native().filesDelete(volume, input.paths);
      }
    },
    transfer: async ({ mode, from, fromPath, to }) => {
      if (from.kind !== "local") throw new Error("Paste this on the server it was copied from.");
      if (mode === "move") return native().filesMove(from.volume, fromPath, volume, to);
      return native().filesCopy(from.volume, fromPath, volume, to);
    },
    upload: (sourceUri, path) => native().filesImport(volume, path, sourceUri),
    download: (path) => native().filesSaveToDownloads(volume, path),
    readText: async (path, maxBytes) =>
      JSON.parse(await native().filesReadText(volume, path, maxBytes)),
    writeText: (path, contents, expectedModifiedAt) =>
      native().filesWriteText(volume, path, contents, expectedModifiedAt),
    fileUri: async (path) => native().filesUri(volume, path),
    openWith: (path, share) => native().filesOpen(volume, path, share),
    search: async (path, query) => JSON.parse(await native().filesSearch(volume, path, query, 300)),
    folderSize: async (path) => JSON.parse(await native().filesSize(volume, path)),
    readBase64: (path, offset, length) => native().filesReadBase64(volume, path, offset, length),
  };
}

/** Every hook a backend may use runs on each render, so switching targets keeps hook order. */
export function useExplorerBackend(target: ExplorerTarget): ExplorerBackend {
  const environmentId = target.kind === "server" ? target.environmentId : null;
  const canWriteServer = useAtomValue(filesystemEnvironment.mutate.permissionAtom(environmentId));
  const mutate = useAtomCommand(filesystemEnvironment.mutate, { reportFailure: false });
  const writeBytes = useAtomCommand(filesystemEnvironment.writeBytes, { reportFailure: false });
  if (target.kind === "local") return localBackend(target.volume);
  const id = target.environmentId;
  const writeBase64 = async (path: string, base64: string, overwrite: boolean) => {
    unwrap(await writeBytes({ environmentId: id, input: { path, base64, overwrite } }));
  };
  return {
    target,
    clipboardKey: `server:${id}`,
    canWrite: canWriteServer,
    mutate: async (input) => {
      unwrap(await mutate({ environmentId: id, input }));
    },
    transfer: async ({ mode, fromPath, to }) => {
      unwrap(
        await mutate({
          environmentId: id,
          input: { _tag: mode === "move" ? "rename" : "copy", from: fromPath, to },
        }),
      );
    },
    upload: async (sourceUri, path) => writeBase64(path, await new File(sourceUri).base64(), false),
    download: async (path) => {
      await downloadFile({
        environmentId: id,
        resource: {
          _tag: "media-file",
          threadId: EXPLORER_THREAD_ID,
          path,
          disposition: "attachment",
        },
        name: explorerBasename(path),
      });
      return null;
    },
    readText: async (path, maxBytes) => {
      const atom = projectEnvironment.readFile({
        environmentId: id,
        input: { cwd: directoryOf(path), relativePath: path },
      });
      const result = await executeAtomQuery(appAtomRegistry, atom, {
        refresh: true,
        reportFailure: false,
        reportDefect: false,
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        if (
          typeof cause === "object" &&
          cause !== null &&
          "failure" in cause &&
          cause.failure === "binary_file"
        ) {
          return { contents: "", byteLength: 0, truncated: false, binary: true, modifiedAt: null };
        }
        throw cause;
      }
      const file = result.value;
      return {
        contents: file.contents.slice(0, maxBytes),
        byteLength: file.byteLength,
        truncated: file.truncated || file.contents.length > maxBytes,
        binary: false,
        modifiedAt: null,
      };
    },
    writeText: async (path, contents) => writeBase64(path, await utf8Base64(contents), true),
    fileUri: (path) =>
      refreshAssetUrl(id, {
        _tag: "draft-workspace-file",
        cwd: directoryOf(path),
        path: explorerBasename(path),
      }),
    openWith: null,
    search: null,
    folderSize: null,
    readBase64: null,
  };
}
