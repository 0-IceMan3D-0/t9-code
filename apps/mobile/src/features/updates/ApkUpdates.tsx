import { useEffect, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { type ApkRelease, appUpdate, findApkUpdate, installApkUpdate } from "./apkUpdates";

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "lastCheckedAt";
const DISMISSED_KEY = "dismissedVersionCode";

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

async function install(release: ApkRelease) {
  try {
    const opened = await installApkUpdate(release);
    if (!opened) {
      Dialog.alert(
        "Allow installing updates",
        "Turn on “Allow from this source” for T3² Code, then come back and tap Update again in Settings > About.",
      );
    }
  } catch (cause) {
    Dialog.alert("Update failed", errorMessage(cause));
  }
}

function offer(release: ApkRelease) {
  Dialog.confirm({
    title: "Update available",
    message: `${release.title} is ready. Android will ask you to confirm the install.`,
    confirmText: "Update",
    cancelText: "Later",
    onConfirm: () => void install(release),
    onCancel: () => appUpdate?.setNumber(DISMISSED_KEY, release.versionCode),
  });
}

/** Mounted for the app's lifetime: checks GitHub at most once a day when the app opens. */
export function ApkUpdateCoordinator() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- checks GitHub once when the app opens
  useEffect(() => {
    const module = appUpdate;
    if (!module) return;
    const now = Date.now();
    if (now - module.getNumber(LAST_CHECK_KEY) < CHECK_EVERY_MS) return;
    module.setNumber(LAST_CHECK_KEY, now);
    // A failed background check stays quiet; Settings > About shows the error on a manual check.
    void findApkUpdate()
      .then((release) => {
        if (release && release.versionCode !== module.getNumber(DISMISSED_KEY)) offer(release);
      })
      .catch(() => undefined);
  }, []);
  return null;
}

type RowState =
  | { readonly kind: "idle" | "checking" | "current" }
  | { readonly kind: "available"; readonly release: ApkRelease }
  | { readonly kind: "downloading"; readonly release: ApkRelease; readonly progress: number }
  | { readonly kind: "failed"; readonly message: string };

/** Settings > About row that checks GitHub for a newer APK and installs it. */
export function ApkUpdateRow() {
  const [state, setState] = useState<RowState>({ kind: "idle" });
  const module = appUpdate;
  if (!module) return null;

  const check = async () => {
    setState({ kind: "checking" });
    setState(
      await findApkUpdate().then(
        (release): RowState => (release ? { kind: "available", release } : { kind: "current" }),
        (cause): RowState => ({ kind: "failed", message: errorMessage(cause) }),
      ),
    );
  };

  const update = async (release: ApkRelease) => {
    setState({ kind: "downloading", release, progress: 0 });
    const subscription = module.addListener("onProgress", ({ progress }) =>
      setState({ kind: "downloading", release, progress }),
    );
    await install(release);
    subscription.remove();
    setState({ kind: "available", release });
  };

  const description =
    state.kind === "checking"
      ? "Checking…"
      : state.kind === "current"
        ? "Up to date"
        : state.kind === "available"
          ? `${state.release.title} is ready`
          : state.kind === "downloading"
            ? `Downloading ${Math.round(state.progress * 100)}%`
            : state.kind === "failed"
              ? state.message
              : `Build ${module.versionCode()}`;

  return (
    <SettingsActionRow
      icon="arrow.down.circle"
      label={
        state.kind === "available" || state.kind === "downloading" ? "Update" : "Check for updates"
      }
      description={description}
      loading={state.kind === "checking" || state.kind === "downloading"}
      disabled={state.kind === "checking" || state.kind === "downloading"}
      onPress={() => void (state.kind === "available" ? update(state.release) : check())}
    />
  );
}
