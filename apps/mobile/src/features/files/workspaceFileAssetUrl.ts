import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { downloadFile } from "../../lib/fileDownload";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import {
  basename,
  isAbsolutePath,
  isAudioPreviewFile,
  isVideoPreviewFile,
  resolveWorkspaceFilePath,
} from "./filePath";

export function useWorkspaceFileAssetUrlState(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
  readonly draftCwd?: string | null;
}) {
  const absolutePath =
    props.cwd !== null && props.relativePath !== null
      ? resolveWorkspaceFilePath(props.cwd, props.relativePath)
      : null;

  const relativePath = props.relativePath;
  const draftCwd = props.draftCwd ?? null;
  const resource = useMemo<AssetResource | null>(() => {
    if (absolutePath === null || relativePath === null) return null;
    if (props.threadId !== null) {
      return {
        _tag:
          isVideoPreviewFile(absolutePath) ||
          isAudioPreviewFile(absolutePath) ||
          isAbsolutePath(relativePath)
            ? "media-file"
            : "workspace-file",
        threadId: props.threadId,
        path: absolutePath,
      };
    }
    if (draftCwd === null) return null;
    return { _tag: "draft-workspace-file", cwd: draftCwd, path: relativePath };
  }, [absolutePath, relativePath, props.threadId, draftCwd]);
  const state = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  return { ...state, resource, refresh };
}

/** Only `media-file` with an attachment disposition skips the server's preview type allowlist. */
export function downloadWorkspaceFile(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string;
  readonly threadId: ThreadId;
}) {
  const path = resolveWorkspaceFilePath(props.cwd, props.relativePath);
  if (path === null) return;
  void downloadFile({
    environmentId: props.environmentId,
    resource: { _tag: "media-file", threadId: props.threadId, path, disposition: "attachment" },
    name: basename(props.relativePath),
  });
}
