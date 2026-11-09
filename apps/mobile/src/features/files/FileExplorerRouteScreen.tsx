import { useAtom } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  EnvironmentId,
  type FilesystemDirectoryEntry,
  type FilesystemMutateInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { AppState, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { formatBytes } from "../../lib/formatBytes";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";
import { localServer, type LocalFilesVolume } from "../local-server/localServerModule";
import {
  errorMessage,
  explorerTargetKey,
  useExplorerBackend,
  useExplorerListing,
  type ExplorerSearchResult,
  type ExplorerTarget,
} from "./explorerBackend";
import {
  explorerBasename,
  explorerBreadcrumbs,
  explorerCopyName,
  joinExplorerPath,
  sortExplorerEntries,
  type ExplorerSeparator,
  type ExplorerSort,
} from "./explorerPath";

export type FileExplorerRouteParams = {
  readonly environmentId?: string;
  readonly volume?: LocalFilesVolume;
  readonly path?: string;
};

type FileExplorerRouteScreenProps = StaticScreenProps<FileExplorerRouteParams>;

interface ExplorerClipboard {
  readonly key: string;
  readonly target: ExplorerTarget;
  readonly mode: "copy" | "move";
  readonly paths: ReadonlyArray<string>;
}

// Shared by every open folder, so "Move" in one folder and "Move here" in another works.
const clipboardAtom = Atom.make<ExplorerClipboard | null>(null).pipe(Atom.keepAlive);
const preferencesAtom = Atom.make({ sort: "name" as ExplorerSort, showHidden: false }).pipe(
  Atom.keepAlive,
);
/** Bumped by every change, so folders further back in the stack reload when shown again. */
export const explorerChangeCountAtom = Atom.make(0).pipe(Atom.keepAlive);

export const VOLUME_LABELS: Record<LocalFilesVolume, string> = {
  linux: "Linux",
  phone: "Phone storage",
};

export function explorerTargetFromParams(params: {
  readonly environmentId?: string;
  readonly volume?: string;
}): ExplorerTarget {
  return params.volume === "linux" || params.volume === "phone"
    ? { kind: "local", volume: params.volume }
    : { kind: "server", environmentId: EnvironmentId.make(params.environmentId ?? "") };
}

export function explorerTargetParams(target: ExplorerTarget) {
  return target.kind === "local"
    ? { volume: target.volume }
    : { environmentId: String(target.environmentId) };
}

function homeOf(target: ExplorerTarget) {
  if (target.kind === "server") return "~";
  return target.volume === "linux" ? "/root" : "/";
}

function formatModified(modifiedAt: number | undefined) {
  if (modifiedAt === undefined) return null;
  const date = new Date(modifiedAt);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric" }),
  });
}

async function pickFiles() {
  const { getDocumentAsync } = await import("expo-document-picker");
  const endHandoff = beginForegroundHandoff();
  try {
    // A cache copy, since provider URIs are not always readable.
    const picked = await getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    return picked.canceled ? null : picked.assets;
  } catch (cause) {
    Dialog.alert("Could not open the file picker", errorMessage(cause));
    return null;
  } finally {
    endHandoff();
  }
}

function entryActions(entry: FilesystemDirectoryEntry, manage: boolean, external: boolean) {
  const file = entry.kind === "file";
  return [
    { id: "open", title: entry.kind === "directory" ? "Open" : "View" },
    ...(file && manage ? [{ id: "edit", title: "Edit" }] : []),
    ...(file && external
      ? [
          { id: "openWith", title: "Open with…" },
          { id: "share", title: "Share…" },
        ]
      : []),
    ...(file ? [{ id: "download", title: "Save to Downloads" }] : []),
    { id: "select", title: "Select" },
    ...(manage
      ? [
          { id: "rename", title: "Rename" },
          { id: "duplicate", title: "Duplicate" },
          { id: "copy", title: "Copy" },
          { id: "cut", title: "Move" },
        ]
      : []),
    { id: "copyPath", title: "Copy path" },
    { id: "info", title: "Info" },
    ...(manage ? [{ id: "delete", title: "Delete", attributes: { destructive: true } }] : []),
  ];
}

function ExplorerRow(props: {
  readonly entry: FilesystemDirectoryEntry;
  /** Shown under the name for search results from other folders. */
  readonly location?: string;
  readonly selecting: boolean;
  readonly selected: boolean;
  readonly cut: boolean;
  readonly canManage: boolean;
  readonly external: boolean;
  readonly onPress: () => void;
  readonly onAction: (action: string) => void;
}) {
  const { entry } = props;
  const details = [
    entry.kind === "directory"
      ? "Folder"
      : entry.byteLength !== undefined
        ? formatBytes(entry.byteLength)
        : null,
    formatModified(entry.modifiedAt),
    entry.symlink ? "Link" : null,
  ].filter(Boolean);
  return (
    <Menu
      title={entry.name}
      shouldOpenOnLongPress
      actions={entryActions(entry, props.canManage, props.external)}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={entry.name}
        accessibilityState={{ selected: props.selected }}
        onPress={props.onPress}
        className={cn(
          "mx-2 min-h-[56px] flex-row items-center gap-3 rounded-[12px] px-3 py-2 active:bg-subtle",
          props.selected && "bg-thread-selected",
          props.cut && "opacity-50",
        )}
      >
        {props.selecting ? (
          <SymbolView
            name={props.selected ? "checkmark.circle.fill" : "circle"}
            size={20}
            tintColorClassName={props.selected ? "accent-focus" : "accent-icon-muted"}
            type="monochrome"
          />
        ) : null}
        <PierreEntryIcon
          path={entry.name}
          kind={entry.kind === "directory" ? "directory" : "file"}
          size={22}
        />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base text-foreground">
            {entry.name}
          </Text>
          {props.location ? (
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              {props.location}
            </Text>
          ) : null}
          {details.length > 0 ? (
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              {details.join(" · ")}
            </Text>
          ) : null}
        </View>
        {entry.kind === "directory" && !props.selecting ? (
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        ) : null}
      </Pressable>
    </Menu>
  );
}

function Breadcrumbs(props: {
  readonly path: string;
  readonly separator: ExplorerSeparator;
  readonly onOpen: (path: string) => void;
}) {
  const crumbs = explorerBreadcrumbs(props.path, props.separator);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      contentContainerClassName="items-center gap-1 px-4 py-2"
    >
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <View key={crumb.path} className="flex-row items-center gap-1">
            {index > 0 ? (
              <SymbolView
                name="chevron.right"
                size={10}
                tintColorClassName="accent-icon-muted"
                type="monochrome"
              />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${crumb.path}`}
              disabled={last}
              onPress={() => props.onOpen(crumb.path)}
              className={cn("rounded-full px-2 py-1", last ? "bg-subtle" : "active:bg-subtle")}
            >
              <Text
                numberOfLines={1}
                className={cn(
                  "text-sm",
                  last ? "font-t3-bold text-foreground" : "text-foreground-muted",
                )}
              >
                {crumb.label}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

function VolumeSwitcher(props: {
  readonly volume: LocalFilesVolume;
  readonly onSwitch: (volume: LocalFilesVolume) => void;
}) {
  return (
    <View className="flex-row gap-2 px-4 pt-2">
      {(["linux", "phone"] as const).map((volume) => (
        <Pressable
          key={volume}
          accessibilityRole="button"
          accessibilityState={{ selected: props.volume === volume }}
          onPress={() => props.onSwitch(volume)}
          className={cn(
            "rounded-full border px-3 py-1.5",
            props.volume === volume ? "border-foreground bg-subtle" : "border-border",
          )}
        >
          <Text className="text-sm text-foreground">{VOLUME_LABELS[volume]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function SelectionBar(props: {
  readonly count: number;
  readonly allSelected: boolean;
  readonly canManage: boolean;
  readonly onToggleAll: () => void;
  readonly onClip: (mode: "copy" | "move") => void;
  readonly onDelete: () => void;
  readonly onDone: () => void;
}) {
  const none = props.count === 0;
  return (
    <View className="flex-row flex-wrap items-center gap-2">
      <Text className="mr-auto text-sm text-foreground-muted">{props.count} selected</Text>
      <Button
        size="compact"
        label={props.allSelected ? "None" : "All"}
        onPress={props.onToggleAll}
      />
      {props.canManage ? (
        <>
          <Button
            size="compact"
            label="Copy"
            disabled={none}
            onPress={() => props.onClip("copy")}
          />
          <Button
            size="compact"
            label="Move"
            disabled={none}
            onPress={() => props.onClip("move")}
          />
          <Button
            size="compact"
            tone="danger"
            label="Delete"
            disabled={none}
            onPress={props.onDelete}
          />
        </>
      ) : null}
      <Button size="compact" tone="text" label="Done" onPress={props.onDone} />
    </View>
  );
}

function useServerAccess(target: ExplorerTarget) {
  const environmentId = target.kind === "server" ? target.environmentId : null;
  const environment = useEnvironmentPresentation(environmentId);
  const session = useEnvironmentQuery(
    environmentId !== null ? environmentSession.sessionStateAtom(environmentId) : null,
  );
  if (environmentId === null) {
    return { canReadFiles: true, isPending: false, error: null, label: null };
  }
  const access = resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
  return {
    ...access,
    label: environment.presentation
      ? (Option.getOrUndefined(environment.presentation.entry.profile)?.label ?? null)
      : null,
  };
}

/** Phone storage needs "All files access", which Android grants on its own settings screen. */
function useStorageAccess(target: ExplorerTarget) {
  const needed = target.kind === "local" && target.volume === "phone";
  const [granted, setGranted] = useState(() => localServer?.filesStorageGranted() ?? false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android's settings screen grants the permission while the app is in the background.
  useEffect(() => {
    if (!needed) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setGranted(localServer?.filesStorageGranted() ?? false);
    });
    return () => subscription.remove();
  }, [needed]);
  return { needed, granted };
}

export function FileExplorerRouteScreen(props: FileExplorerRouteScreenProps) {
  const target = explorerTargetFromParams(props.route.params);
  return (
    <FileExplorer key={explorerTargetKey(target)} target={target} params={props.route.params} />
  );
}

function FileExplorer(props: {
  readonly target: ExplorerTarget;
  readonly params: FileExplorerRouteParams;
}) {
  const { target } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const requestedPath = props.params.path ?? homeOf(target);
  const access = useServerAccess(target);
  const storage = useStorageAccess(target);
  const readable = access.canReadFiles && (!storage.needed || storage.granted);
  const backend = useExplorerBackend(target);
  const { listing, error, isPending, refresh } = useExplorerListing(
    readable ? target : null,
    requestedPath,
  );
  const [clipboard, setClipboard] = useAtom(clipboardAtom);
  const [preferences, setPreferences] = useAtom(preferencesAtom);
  const [changeCount, setChangeCount] = useAtom(explorerChangeCountAtom);
  const [filter, setFilter] = useState("");
  const [deepResults, setDeepResults] = useState<{
    readonly query: string;
    readonly entries: ReadonlyArray<ExplorerSearchResult> | null;
    readonly truncated: boolean;
  } | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const focused = useIsFocused();
  const seenChanges = useRef(changeCount);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A change made from another folder's screen leaves this listing stale until it is shown again.
  useEffect(() => {
    if (!focused || seenChanges.current === changeCount) return;
    seenChanges.current = changeCount;
    refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- refresh is recreated each render.
  }, [focused, changeCount]);

  const canManage = (listing?.canManage ?? false) && backend.canWrite;
  const external = backend.openWith !== null;
  const separator = listing?.separator ?? "/";
  const directory = listing?.path ?? requestedPath;
  const entries = listing ? sortExplorerEntries(listing.entries, { ...preferences, filter }) : [];
  const pathOf = (name: string) => joinExplorerPath(directory, name, separator);
  const takenNames = new Set(listing?.entries.map((entry) => entry.name) ?? []);

  const changed = () => {
    setChangeCount((count) => count + 1);
    seenChanges.current += 1;
    refresh();
  };

  const openFolder = (path: string) =>
    navigation.dispatch(
      StackActions.push(target.kind === "local" ? "LocalFileExplorer" : "FileExplorer", {
        ...explorerTargetParams(target),
        path,
      }),
    );
  const openFile = (path: string, mode?: "edit") =>
    navigation.dispatch(
      StackActions.push("ExplorerFile", {
        ...explorerTargetParams(target),
        path,
        ...(mode ? { mode } : {}),
      }),
    );

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    const outcome = await work().then(
      () => null,
      (cause: unknown) => errorMessage(cause),
    );
    setBusy(null);
    changed();
    if (outcome !== null) Dialog.alert(`Could not ${label.toLowerCase()}`, outcome);
    return outcome === null;
  };
  const mutate = (label: string, input: FilesystemMutateInput) =>
    run(label, () => backend.mutate(input));

  const promptName = (title: string, initialValue: string, onName: (name: string) => void) =>
    Dialog.prompt({
      title,
      initialValue,
      confirmText: "Save",
      onConfirm: (value) => {
        const name = value.trim();
        if (name.length === 0) return;
        if (/[\\/]/.test(name) || name === "." || name === "..") {
          Dialog.alert("Invalid name", "A name cannot be . or .. or contain / or \\.");
          return;
        }
        onName(name);
      },
    });

  const confirmDelete = (paths: ReadonlyArray<string>, onDone?: () => void) =>
    Dialog.confirm({
      title:
        paths.length === 1
          ? `Delete ${explorerBasename(paths[0] ?? "")}?`
          : `Delete ${paths.length} items?`,
      message: "Folders are deleted with everything inside them. This cannot be undone.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () =>
        void mutate("Delete", { _tag: "delete", paths }).then((ok) => {
          if (ok) onDone?.();
        }),
    });

  const pasteAll = async (current: ExplorerClipboard) => {
    const taken = new Set(takenNames);
    const sameTarget = explorerTargetKey(current.target) === explorerTargetKey(target);
    for (const from of current.paths) {
      const name = explorerBasename(from);
      if (sameTarget && current.mode === "move" && from === pathOf(name)) continue;
      const destination = taken.has(name) ? explorerCopyName(name, taken) : name;
      taken.add(destination);
      setBusy(`${current.mode === "move" ? "Moving" : "Copying"} ${name}`);
      await backend.transfer({
        mode: current.mode,
        from: current.target,
        fromPath: from,
        to: pathOf(destination),
      });
    }
  };
  const paste = async (current: ExplorerClipboard) => {
    const ok = await run(current.mode === "move" ? "Move" : "Paste", () => pasteAll(current));
    if (ok && current.mode === "move") setClipboard(null);
  };

  const uploadAll = async (
    assets: ReadonlyArray<{ readonly name: string; readonly uri: string }>,
  ) => {
    const taken = new Set(takenNames);
    for (const asset of assets) {
      const original = asset.name.trim() || "file";
      const name = taken.has(original) ? explorerCopyName(original, taken) : original;
      taken.add(name);
      setBusy(`Uploading ${name}`);
      await backend.upload(asset.uri, pathOf(name));
    }
  };
  const upload = async () => {
    const assets = await pickFiles();
    if (assets !== null) await run("Upload", () => uploadAll(assets));
  };

  const download = async (path: string) => {
    setBusy(`Saving ${explorerBasename(path)}`);
    const saved = await backend.download(path).catch((cause: unknown) => {
      Dialog.alert("Could not save to Downloads", errorMessage(cause));
      return undefined;
    });
    setBusy(null);
    if (typeof saved === "string")
      Dialog.alert("Saved to Downloads", `Downloads/T3² code/${saved}`);
  };

  const showInfo = async (entry: FilesystemDirectoryEntry, path: string) => {
    const lines = [
      `Path: ${path}`,
      `Type: ${entry.kind === "directory" ? "Folder" : entry.kind === "file" ? "File" : "Other"}${entry.symlink ? " (link)" : ""}`,
      entry.byteLength !== undefined
        ? `Size: ${formatBytes(entry.byteLength)} (${entry.byteLength.toLocaleString()} bytes)`
        : null,
      entry.modifiedAt !== undefined
        ? `Modified: ${new Date(entry.modifiedAt).toLocaleString()}`
        : null,
    ];
    if (entry.kind === "directory" && backend.folderSize) {
      setBusy("Measuring");
      const size = await backend.folderSize(path).catch(() => null);
      setBusy(null);
      if (size) {
        lines.push(
          `Contents: ${formatBytes(size.byteLength)} in ${size.files.toLocaleString()} files and ${size.folders.toLocaleString()} folders${size.complete ? "" : " (stopped counting)"}`,
        );
      }
    }
    Dialog.alert(entry.name, lines.filter(Boolean).join("\n"));
  };

  const toggleSelected = (name: string) =>
    setSelection((current) => {
      const next = new Set(current ?? []);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const handleAction = (entry: FilesystemDirectoryEntry, path: string, action: string) => {
    const parent = path.slice(0, path.length - entry.name.length);
    switch (action) {
      case "open":
        return entry.kind === "directory" ? openFolder(path) : openFile(path);
      case "edit":
        return openFile(path, "edit");
      case "openWith":
      case "share":
        return void backend
          .openWith?.(path, action === "share")
          .catch((cause: unknown) => Dialog.alert("Could not open the file", errorMessage(cause)));
      case "download":
        return void download(path);
      case "select":
        return setSelection(new Set([entry.name]));
      case "rename":
        return promptName("Rename", entry.name, (name) => {
          if (name !== entry.name)
            void mutate("Rename", { _tag: "rename", from: path, to: `${parent}${name}` });
        });
      case "duplicate":
        return void mutate("Duplicate", {
          _tag: "copy",
          from: path,
          to: `${parent}${explorerCopyName(entry.name, parent === pathOf("") ? takenNames : new Set([entry.name]))}`,
        });
      case "copy":
      case "cut":
        return setClipboard({
          key: backend.clipboardKey,
          target,
          mode: action === "cut" ? "move" : "copy",
          paths: [path],
        });
      case "copyPath":
        return copyTextWithHaptic(path);
      case "info":
        return void showInfo(entry, path);
      case "delete":
        return confirmDelete([path]);
    }
  };

  const runDeepSearch = () => {
    const query = filter.trim();
    if (!backend.search || query.length === 0) return;
    setDeepResults({ query, entries: null, truncated: false });
    backend
      .search(directory, query)
      .then((result) => setDeepResults({ query, ...result }))
      .catch((cause: unknown) => {
        setDeepResults(null);
        Dialog.alert("Search failed", errorMessage(cause));
      });
  };
  const showingDeep = deepResults !== null && deepResults.query === filter.trim();

  const selectedPaths = [...(selection ?? [])].map(pathOf);
  const pasteable = clipboard !== null && clipboard.key === backend.clipboardKey && canManage;
  const title =
    listing && listing.path !== "/"
      ? explorerBasename(listing.path)
      : target.kind === "local"
        ? VOLUME_LABELS[target.volume]
        : "Files";

  const menuItems = [
    ...(canManage
      ? [
          {
            id: "new",
            inline: true,
            items: [
              {
                id: "newFolder",
                title: "New folder",
                icon: "folder.badge.plus",
                onPress: () =>
                  promptName(
                    "New folder",
                    "",
                    (name) =>
                      void mutate("Create folder", { _tag: "createDirectory", path: pathOf(name) }),
                  ),
              },
              {
                id: "newFile",
                title: "New file",
                icon: "doc",
                onPress: () =>
                  promptName(
                    "New file",
                    "",
                    (name) =>
                      void mutate("Create file", { _tag: "createFile", path: pathOf(name) }).then(
                        (ok) => {
                          if (ok) openFile(pathOf(name), "edit");
                        },
                      ),
                  ),
              },
              {
                id: "upload",
                title: target.kind === "local" ? "Import from phone" : "Upload from phone",
                icon: "tray.and.arrow.up",
                onPress: () => void upload(),
              },
            ],
          },
        ]
      : []),
    {
      id: "go",
      inline: true,
      items: [
        {
          id: "home",
          title: "Home folder",
          icon: "house",
          onPress: () => openFolder(listing?.homePath ?? homeOf(target)),
        },
        {
          id: "goTo",
          title: "Go to path…",
          icon: "arrow.right.circle",
          onPress: () =>
            Dialog.prompt({
              title: "Go to path",
              ...(target.kind === "server"
                ? { message: "An absolute path, or one starting with ~/." }
                : {}),
              initialValue: directory,
              confirmText: "Open",
              onConfirm: (value) => {
                if (value.trim().length > 0) openFolder(value.trim());
              },
            }),
        },
        {
          id: "copyCurrentPath",
          title: "Copy folder path",
          icon: "doc.on.doc",
          onPress: () => copyTextWithHaptic(directory),
        },
      ],
    },
    {
      id: "view",
      title: "Sort by",
      icon: "line.3.horizontal.decrease",
      items: (
        [
          ["name", "Name"],
          ["modified", "Date modified"],
          ["size", "Size"],
        ] as const
      ).map(([sort, label]) => ({
        id: `sort-${sort}`,
        title: label,
        selected: preferences.sort === sort,
        onPress: () => setPreferences((current) => ({ ...current, sort })),
      })),
    },
    {
      id: "hidden",
      title: preferences.showHidden ? "Hide hidden files" : "Show hidden files",
      icon: preferences.showHidden ? "eye.slash" : "eye",
      onPress: () => setPreferences((current) => ({ ...current, showHidden: !current.showHidden })),
    },
    {
      id: "selectMode",
      title: "Select",
      icon: "checkmark.circle",
      onPress: () => setSelection(new Set()),
    },
  ];

  const clipboardSource =
    clipboard !== null &&
    clipboard.target.kind === "local" &&
    target.kind === "local" &&
    clipboard.target.volume !== target.volume
      ? ` from ${VOLUME_LABELS[clipboard.target.volume]}`
      : "";
  const bottomBar =
    selection !== null ? (
      <SelectionBar
        count={selection.size}
        allSelected={selection.size === entries.length && entries.length > 0}
        canManage={canManage}
        onToggleAll={() =>
          setSelection(
            selection.size === entries.length
              ? new Set()
              : new Set(entries.map((entry) => entry.name)),
          )
        }
        onClip={(mode) => {
          setClipboard({ key: backend.clipboardKey, target, mode, paths: selectedPaths });
          setSelection(null);
        }}
        onDelete={() => confirmDelete(selectedPaths, () => setSelection(null))}
        onDone={() => setSelection(null)}
      />
    ) : pasteable ? (
      <View className="flex-row items-center gap-2">
        <Text numberOfLines={2} className="mr-auto flex-1 text-sm text-foreground-muted">
          {clipboard.mode === "move" ? "Move" : "Copy"}{" "}
          {clipboard.paths.length === 1
            ? explorerBasename(clipboard.paths[0] ?? "")
            : `${clipboard.paths.length} items`}
          {clipboardSource} here?
        </Text>
        <Button size="compact" tone="text" label="Cancel" onPress={() => setClipboard(null)} />
        <Button
          size="compact"
          tone="primary"
          label={clipboard.mode === "move" ? "Move here" : "Paste"}
          disabled={busy !== null}
          onPress={() => void paste(clipboard)}
        />
      </View>
    ) : null;

  const renderEntry = (item: FilesystemDirectoryEntry, path: string, location?: string) => (
    <ExplorerRow
      entry={item}
      {...(location ? { location } : {})}
      selecting={selection !== null && location === undefined}
      selected={selection?.has(item.name) ?? false}
      cut={clipboard?.mode === "move" && clipboard.paths.includes(path)}
      canManage={canManage}
      external={external}
      onPress={() => {
        if (selection !== null && location === undefined) toggleSelected(item.name);
        else if (item.kind === "directory") openFolder(path);
        else openFile(path);
      }}
      onAction={(action) => handleAction(item, path, action)}
    />
  );

  const emptyState = (
    <View className="px-4 py-6">
      {storage.needed && !storage.granted ? (
        <>
          <Text className="text-sm font-t3-bold text-foreground">
            Allow access to phone storage
          </Text>
          <Text className="mt-1 text-xs text-foreground-muted">
            Android asks you to turn on "Allow access to manage all files" for T3² Code.
          </Text>
          <View className="mt-3 flex-row">
            <Button
              label="Open Android settings"
              onPress={() => void localServer?.requestStorageAccess()}
            />
          </View>
        </>
      ) : !access.canReadFiles && !access.isPending ? (
        <Text className="text-sm text-foreground-muted">
          {access.error ?? "This connection cannot read host files."}
        </Text>
      ) : error && !listing ? (
        <>
          <Text className="text-sm font-t3-bold text-foreground">Folder unavailable</Text>
          <Text selectable accessibilityRole="alert" className="mt-1 text-xs text-foreground-muted">
            {error}
          </Text>
          <View className="mt-3 flex-row gap-2">
            <Button label="Try again" onPress={refresh} disabled={isPending} />
            <Button label="Home folder" tone="text" onPress={() => openFolder(homeOf(target))} />
          </View>
        </>
      ) : isPending || access.isPending || !listing ? (
        <AppActivityIndicator size="small" />
      ) : (
        <Text className="text-sm text-foreground-muted">
          {filter.trim().length > 0 ? "Nothing in this folder matches." : "This folder is empty."}
        </Text>
      )}
    </View>
  );

  const listPadding = { paddingTop: 4, paddingBottom: insets.bottom + 96 };

  return (
    <View className="flex-1">
      <AppBar
        title={title}
        subtitle={
          target.kind === "local" ? `This phone · ${VOLUME_LABELS[target.volume]}` : access.label
        }
        onBack={() => navigation.goBack()}
        hideBottomBorder
        matchSearchSurface
        search={{
          value: filter,
          onChangeText: setFilter,
          placeholder: backend.search ? "Filter, or search subfolders" : "Filter this folder",
          closeAccessibilityLabel: "Close filter",
          clearAccessibilityLabel: "Clear filter",
        }}
        refresh={{ accessibilityLabel: "Refresh folder", onPress: refresh }}
        menus={[{ title: "Folder actions", icon: "ellipsis", items: menuItems }]}
      />
      <ScreenContent>
        {target.kind === "local" && props.params.path === undefined ? (
          <VolumeSwitcher
            volume={target.volume}
            onSwitch={(volume) => {
              if (volume !== target.volume)
                navigation.dispatch(StackActions.replace("LocalFileExplorer", { volume }));
            }}
          />
        ) : null}
        {listing ? (
          <Breadcrumbs path={listing.path} separator={separator} onOpen={openFolder} />
        ) : null}
        {listing && !listing.canManage ? (
          <Text className="mx-4 mb-1 text-xs text-foreground-muted">
            This server is older than the file explorer. Update it to rename, move, delete, upload
            and see sizes.
          </Text>
        ) : null}
        {backend.search && filter.trim().length > 0 && !showingDeep ? (
          <Pressable
            accessibilityRole="button"
            onPress={runDeepSearch}
            className="mx-4 mb-1 flex-row items-center gap-2 rounded-[12px] bg-subtle px-3 py-2"
          >
            <SymbolView
              name="magnifyingglass"
              size={14}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
            <Text className="flex-1 text-sm text-foreground">
              Search “{filter.trim()}” in all subfolders
            </Text>
          </Pressable>
        ) : null}
        {busy !== null ? (
          <View className="mx-4 mb-1 flex-row items-center gap-2">
            <AppActivityIndicator size="small" />
            <Text className="text-xs text-foreground-muted">{busy}…</Text>
          </View>
        ) : null}
        {showingDeep ? (
          <LegendList
            renderScrollComponent={NativeScrollView}
            className="flex-1"
            data={deepResults.entries ?? []}
            keyExtractor={(entry) => entry.path}
            estimatedItemSize={64}
            recycleItems
            extraData={{ clipboard }}
            contentContainerStyle={listPadding}
            renderItem={({ item }) =>
              renderEntry(
                item,
                item.path,
                item.path.slice(0, item.path.length - item.name.length - 1) || "/",
              )
            }
            ListHeaderComponent={
              <View className="mx-4 my-1 flex-row items-center gap-2">
                <Text className="flex-1 text-xs text-foreground-muted">
                  {deepResults.entries === null
                    ? "Searching…"
                    : `${deepResults.entries.length} found${deepResults.truncated ? ", search stopped early" : ""}`}
                </Text>
                <Button
                  size="compact"
                  tone="text"
                  label="Back to folder"
                  onPress={() => setDeepResults(null)}
                />
              </View>
            }
            ListEmptyComponent={
              deepResults.entries === null ? null : (
                <Text className="px-4 py-6 text-sm text-foreground-muted">No matches.</Text>
              )
            }
          />
        ) : (
          <LegendList
            renderScrollComponent={NativeScrollView}
            alwaysBounceVertical
            className="flex-1"
            data={entries}
            keyExtractor={(entry) => entry.name}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            estimatedItemSize={56}
            recycleItems
            extraData={{ selection, clipboard }}
            contentContainerStyle={listPadding}
            refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
            renderItem={({ item }) => renderEntry(item, pathOf(item.name))}
            ListHeaderComponent={
              listing?.truncated ? (
                <Text className="mx-4 my-2 text-xs text-foreground-muted">
                  This folder has more items than can be shown at once.
                </Text>
              ) : null
            }
            ListEmptyComponent={emptyState}
          />
        )}
        {bottomBar ? (
          <View
            className="absolute inset-x-3 rounded-[20px] border border-border bg-card-alt px-4 py-3"
            style={{ bottom: insets.bottom + 12 }}
          >
            {bottomBar}
          </View>
        ) : null}
      </ScreenContent>
    </View>
  );
}
