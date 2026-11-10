import { useAtom } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewDelimiter, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
} from "@t3tools/shared/filePreview";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { formatBytes } from "../../lib/formatBytes";
import { isPdfFile } from "../../lib/filePreview";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { localServer, useLocalServerStatus } from "../local-server/localServerModule";
import { AudioFilePreview } from "./AudioFilePreview";
import { DelimitedFilePreview } from "./DelimitedFilePreview";
import {
  errorMessage,
  explorerTargetKey,
  useExplorerBackend,
  type ExplorerTextFile,
} from "./explorerBackend";
import { hexRows } from "./explorerEditing";
import { explorerBasename } from "./explorerPath";
import {
  explorerChangeCountAtom,
  explorerTargetFromParams,
  VOLUME_LABELS,
} from "./FileExplorerRouteScreen";
import { ExplorerTextEditor } from "./ExplorerTextEditor";
import { isAudioPreviewFile, isMarkdownPreviewFile, isVideoPreviewFile } from "./filePath";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { SourceFileSurface } from "./SourceFileSurface";
import { WorkspaceFileImagePreview } from "./WorkspaceFileImagePreview";
import { WorkspaceFileVideoPreview } from "./WorkspaceFileVideoPreview";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";

type ExplorerFileScreenProps = StaticScreenProps<{
  readonly environmentId?: string;
  readonly volume?: string;
  readonly path: string;
  readonly mode?: "edit";
}>;

type Mode = "view" | "edit" | "preview" | "media" | "hex";

const TEXT_MAX_BYTES = 1024 * 1024;
/** A TextInput gets slow well before a viewer does, so larger files open read-only. */
const EDIT_MAX_BYTES = 512 * 1024;
const HEX_CHUNK = 16 * 1024;

function mediaKind(path: string) {
  if (isVideoPreviewFile(path)) return "video";
  if (isAudioPreviewFile(path)) return "audio";
  if (isWorkspaceImagePreviewPath(path)) return "image";
  if (isPdfFile({ name: path }) || isWorkspaceBrowserPreviewPath(path)) return "document";
  return null;
}

function decodeBase64(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The built-in server sees Linux at the same paths, so its id renders Markdown images. */
function useMarkdownEnvironmentId(target: ReturnType<typeof explorerTargetFromParams>) {
  const status = useLocalServerStatus();
  const { savedConnectionsById } = useSavedRemoteConnections();
  if (target.kind === "server") return target.environmentId;
  const local = Object.values(savedConnectionsById).find(
    (connection) =>
      connection.httpBaseUrl.replace(/\/$/, "") === `http://127.0.0.1:${status?.port ?? 0}`,
  );
  return target.volume === "linux" && local
    ? local.environmentId
    : EnvironmentId.make("this-phone");
}

function HexView(props: {
  readonly read: (offset: number, length: number) => Promise<string>;
  readonly byteLength: number | null;
  readonly bottomInset: number;
}) {
  const [rows, setRows] = useState<ReadonlyArray<string>>([]);
  const [loaded, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = (offset: number) => {
    setLoading(true);
    props
      .read(offset, HEX_CHUNK)
      .then((base64) => {
        const bytes = decodeBase64(base64);
        setRows((current) => [...current, ...hexRows(bytes, offset)]);
        setLoaded(offset + bytes.length);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  };
  const started = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads the first bytes from disk when the hex view opens.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    load(0);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- loads once per mount.
  }, []);
  const more = props.byteLength === null || loaded < props.byteLength;
  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ paddingBottom: props.bottomInset + 24 }}
    >
      <ScrollView horizontal>
        <Text selectable className="px-3 py-2 font-mono text-xs leading-5 text-foreground">
          {rows.join("\n")}
        </Text>
      </ScrollView>
      {error ? <Text className="mx-3 text-sm text-danger-foreground">{error}</Text> : null}
      {more && rows.length > 0 ? (
        <View className="flex-row px-3 py-2">
          <Button label="Load more" loading={loading} onPress={() => load(loaded)} />
        </View>
      ) : loading ? (
        <AppActivityIndicator size="small" />
      ) : null}
    </ScrollView>
  );
}

export function ExplorerFileScreen(props: ExplorerFileScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const params = props.route.params;
  const target = explorerTargetFromParams(params);
  const backend = useExplorerBackend(target);
  const markdownEnvironmentId = useMarkdownEnvironmentId(target);
  const [, setChangeCount] = useAtom(explorerChangeCountAtom);
  const { path } = params;
  const name = explorerBasename(path);
  const directory = path.slice(0, Math.max(path.length - name.length - 1, 1));
  const media = mediaKind(path);
  const delimiter = filePreviewDelimiter({ name });
  const previewable = isMarkdownPreviewFile(path) || delimiter !== null;

  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);
  const [mode, setMode] = useState<Mode>(
    params.mode === "edit" ? "edit" : media ? "media" : previewable ? "preview" : "view",
  );
  const loadKey = JSON.stringify([explorerTargetKey(target), path, reloadCount]);
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly path: string;
    readonly file: ExplorerTextFile | null;
    readonly uri: string | null;
    readonly error: string | null;
  }>({ key: "", path, file: null, uri: null, error: null });
  const backendRef = useRef(backend);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The loader below reads the newest backend without reloading each time it is rebuilt.
  useEffect(() => {
    backendRef.current = backend;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads the file from its server or the phone's disk.
  useEffect(() => {
    let live = true;
    const source = backendRef.current;
    // A reload keeps showing the previous contents until the new ones arrive.
    const update = (patch: Partial<typeof loaded>) => {
      if (live)
        setLoaded((previous) => ({ ...previous, key: loadKey, path, error: null, ...patch }));
    };
    const fail = (cause: unknown) => update({ error: errorMessage(cause) });
    if (media) source.fileUri(path).then((uri) => update({ uri }), fail);
    if (media !== "video" && media !== "audio" && media !== "image") {
      source.readText(path, TEXT_MAX_BYTES).then((result) => {
        update({ file: result });
        if (live && result.binary && !media) setMode(source.readBase64 ? "hex" : "view");
      }, fail);
    }
    return () => {
      live = false;
    };
  }, [loadKey, media, path]);
  const current = loaded.path === path ? loaded : null;
  const file = current?.file ?? null;
  const mediaUri = current?.uri ?? null;
  const loadError = current?.error ?? null;

  const contents = draft ?? file?.contents ?? "";
  const dirty = draft !== null && draft !== file?.contents;
  const editable =
    backend.canWrite &&
    file !== null &&
    !file.binary &&
    !file.truncated &&
    file.byteLength <= EDIT_MAX_BYTES;
  const leaving = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android's back gesture leaves through navigation, which must ask before unsaved edits are lost.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (!dirty || leaving.current) return;
        event.preventDefault();
        Dialog.confirm({
          title: "Discard unsaved changes?",
          confirmText: "Discard",
          destructive: true,
          onConfirm: () => {
            leaving.current = true;
            navigation.dispatch(event.data.action);
          },
        });
      }),
    [navigation, dirty],
  );

  const write = async (overwrite: boolean) => {
    setSaving(true);
    const outcome = await backend
      .writeText(path, contents, overwrite ? null : (file?.modifiedAt ?? null))
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    setSaving(false);
    if (outcome === null) {
      setChangeCount((count) => count + 1);
      setLoaded((previous) => ({
        ...previous,
        file: previous.file ? { ...previous.file, contents, modifiedAt: null } : previous.file,
      }));
      setDraft(null);
      setReloadCount((count) => count + 1);
      return;
    }
    const code =
      typeof outcome === "object" && outcome !== null && "code" in outcome ? outcome.code : null;
    if (code === "ERR_CHANGED") {
      Dialog.confirm({
        title: "The file changed on disk",
        message: "Something else saved it since you opened it. Overwrite it with your version?",
        confirmText: "Overwrite",
        destructive: true,
        onConfirm: () => void write(true),
      });
      return;
    }
    Dialog.alert("Could not save", errorMessage(outcome));
  };

  const modes: Array<{ value: Mode; label: string }> = [
    ...(media
      ? [{ value: "media" as const, label: media === "document" ? "Document" : "Preview" }]
      : []),
    ...(previewable ? [{ value: "preview" as const, label: "Preview" }] : []),
    ...(file && !file.binary ? [{ value: "view" as const, label: "Code" }] : []),
    ...(editable ? [{ value: "edit" as const, label: "Edit" }] : []),
    ...(backend.readBase64 ? [{ value: "hex" as const, label: "Hex" }] : []),
  ];

  const menuItems = [
    ...(backend.openWith
      ? [
          {
            id: "openWith",
            title: "Open with…",
            icon: "arrow.up.right",
            onPress: () =>
              void backend
                .openWith?.(path, false)
                .catch((cause: unknown) =>
                  Dialog.alert("Could not open the file", errorMessage(cause)),
                ),
          },
          {
            id: "share",
            title: "Share…",
            icon: "square.and.arrow.up",
            onPress: () =>
              void backend
                .openWith?.(path, true)
                .catch((cause: unknown) =>
                  Dialog.alert("Could not share the file", errorMessage(cause)),
                ),
          },
        ]
      : []),
    {
      id: "download",
      title: "Save to Downloads",
      icon: "tray.and.arrow.down",
      onPress: () =>
        void backend.download(path).then(
          (saved) => {
            if (typeof saved === "string")
              Dialog.alert("Saved to Downloads", `Downloads/T3² Code/${saved}`);
          },
          (cause: unknown) => Dialog.alert("Could not save to Downloads", errorMessage(cause)),
        ),
    },
    {
      id: "copyPath",
      title: "Copy path",
      icon: "doc.on.doc",
      onPress: () => copyTextWithHaptic(path),
    },
    ...(file && !file.binary
      ? [
          {
            id: "copyText",
            title: "Copy contents",
            icon: "doc.text",
            onPress: () => copyTextWithHaptic(contents),
          },
        ]
      : []),
    ...(dirty
      ? [
          {
            id: "revert",
            title: "Revert changes",
            icon: "arrow.uturn.backward",
            destructive: true,
            onPress: () => setDraft(null),
          },
        ]
      : []),
    {
      id: "reload",
      title: "Reload from disk",
      icon: "arrow.clockwise",
      onPress: () => {
        setDraft(null);
        setReloadCount((count) => count + 1);
      },
    },
  ];

  const subtitle = [
    target.kind === "local" ? VOLUME_LABELS[target.volume] : null,
    dirty ? "Edited" : file ? formatBytes(file.byteLength) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const body = () => {
    if (loadError && !file && !mediaUri) {
      return (
        <View className="p-4">
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {loadError}
          </Text>
          <View className="mt-3 flex-row">
            <Button label="Try again" onPress={() => setReloadCount((count) => count + 1)} />
          </View>
        </View>
      );
    }
    if (mode === "hex" && backend.readBase64) {
      const read = backend.readBase64;
      return (
        <HexView
          read={(offset, length) => read(path, offset, length)}
          byteLength={file?.byteLength ?? null}
          bottomInset={insets.bottom}
        />
      );
    }
    if (mode === "media") {
      if (mediaUri === null) return <AppActivityIndicator size="small" />;
      if (media === "image")
        return <WorkspaceFileImagePreview accessibilityLabel={name} uri={mediaUri} />;
      if (media === "video") {
        return (
          <WorkspaceFileVideoPreview
            name={name}
            thumbnailKey={path}
            uri={mediaUri}
            source={null}
            resolvePlaybackUri={() => backend.fileUri(path)}
          />
        );
      }
      if (media === "audio") {
        return (
          <AudioFilePreview uri={mediaUri} onRetry={() => setReloadCount((count) => count + 1)} />
        );
      }
      // Android's WebView cannot render a PDF, and a local file needs another app either way.
      if (target.kind === "local" || isPdfFile({ name })) {
        return (
          <View className="items-start gap-3 p-4">
            <Text className="text-sm text-foreground-muted">
              {isPdfFile({ name })
                ? "PDFs open in another app."
                : "Open this document in a browser or another app."}
            </Text>
            {backend.openWith ? (
              <Button label="Open with…" onPress={() => void backend.openWith?.(path, false)} />
            ) : (
              <Button label="Save to Downloads" onPress={() => void backend.download(path)} />
            )}
          </View>
        );
      }
      return <WorkspaceFileWebPreview uri={mediaUri} />;
    }
    if (file === null) return <AppActivityIndicator size="small" />;
    if (file.binary) {
      return (
        <View className="items-start gap-3 p-4">
          <Text className="text-sm text-foreground-muted">
            This is a binary file ({formatBytes(file.byteLength)}), so it has no text to show.
          </Text>
          {backend.openWith ? (
            <Button label="Open with…" onPress={() => void backend.openWith?.(path, false)} />
          ) : null}
        </View>
      );
    }
    if (mode === "preview" && delimiter !== null) {
      return <DelimitedFilePreview table={parseDelimitedPreview(contents, delimiter)} />;
    }
    if (mode === "preview") {
      return (
        <FileMarkdownPreview
          cwd={directory}
          environmentId={markdownEnvironmentId}
          markdown={contents}
          relativePath={name}
          threadId={null}
        />
      );
    }
    if (mode === "edit") {
      return (
        <ExplorerTextEditor
          value={contents}
          onChange={setDraft}
          editable={editable}
          bottomInset={insets.bottom}
        />
      );
    }
    return <SourceFileSurface contents={contents} path={name} selectable />;
  };

  return (
    <View className="flex-1">
      <AppBar
        title={name}
        subtitle={subtitle}
        onBack={() => navigation.goBack()}
        hideBottomBorder
        actions={
          mode === "edit" && editable
            ? [
                {
                  accessibilityLabel: "Save",
                  icon: "checkmark",
                  disabled: !dirty || saving,
                  loading: saving,
                  onPress: () => void write(false),
                },
              ]
            : undefined
        }
        menus={[{ title: "File actions", icon: "ellipsis", items: menuItems }]}
      />
      <ScreenContent>
        {modes.length > 1 ? (
          <View className="px-4 pb-2 pt-1">
            <SegmentedControl
              size="compact"
              options={modes}
              selected={mode}
              onSelect={(value) => setMode(value)}
            />
          </View>
        ) : null}
        {file?.truncated ? (
          <Text className="mx-4 mb-1 text-xs text-foreground-muted">
            Only the first {formatBytes(TEXT_MAX_BYTES)} is shown, so this file opens read-only.
          </Text>
        ) : file && !file.binary && file.byteLength > EDIT_MAX_BYTES && !file.truncated ? (
          <Text className="mx-4 mb-1 text-xs text-foreground-muted">
            Files over {formatBytes(EDIT_MAX_BYTES)} open read-only to keep typing smooth.
          </Text>
        ) : null}
        {!localServer && target.kind === "local" ? (
          <Text className="m-4 text-sm text-foreground-muted">
            Direct file access needs the Android app.
          </Text>
        ) : (
          body()
        )}
      </ScreenContent>
    </View>
  );
}
