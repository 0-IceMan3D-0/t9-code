import { requireOptionalNativeModule, type EventSubscription } from "expo";
import { Platform } from "react-native";

/** GitHub releases that the t9-code workflow publishes, one per push to main. */
export const RELEASES_REPO = "0-IceMan3D-0/t9-code";
const APK_ASSET = "t9-code.apk";
const TAG = /^b(\d+)$/;

interface T3AppUpdateModule {
  versionCode(): number;
  canInstall(): boolean;
  openInstallSettings(): void;
  getNumber(key: string): number;
  setNumber(key: string, value: number): void;
  /** Resolves once Android's installer is open; the user confirms the install there. */
  downloadAndInstall(url: string): Promise<void>;
  addListener(
    event: "onProgress",
    listener: (event: { readonly progress: number }) => void,
  ): EventSubscription;
}

export const appUpdate =
  Platform.OS === "android" ? requireOptionalNativeModule<T3AppUpdateModule>("T3AppUpdate") : null;

export interface ApkRelease {
  readonly versionCode: number;
  readonly title: string;
  readonly apkUrl: string;
}

/** Reads GitHub's latest-release response; null when it is not a t9-code APK release. */
export function parseRelease(json: unknown): ApkRelease | null {
  if (typeof json !== "object" || json === null) return null;
  const release = json as {
    readonly tag_name?: unknown;
    readonly name?: unknown;
    readonly assets?: ReadonlyArray<{
      readonly name?: unknown;
      readonly browser_download_url?: unknown;
    }>;
  };
  const match = typeof release.tag_name === "string" ? TAG.exec(release.tag_name) : null;
  const asset = release.assets?.find((entry) => entry.name === APK_ASSET);
  if (!match || typeof asset?.browser_download_url !== "string") return null;
  return {
    versionCode: Number(match[1]),
    title:
      typeof release.name === "string" && release.name.length > 0
        ? release.name
        : `Build ${match[1]}`,
    apkUrl: asset.browser_download_url,
  };
}

/** The newest release when it is newer than this build, otherwise null. */
export async function findApkUpdate(): Promise<ApkRelease | null> {
  if (!appUpdate) return null;
  const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  const release = parseRelease(await response.json());
  return release && release.versionCode > appUpdate.versionCode() ? release : null;
}

/**
 * Opens Android's installer for the release. Returns false when Android first needs permission
 * to install apps from T3² Code; its settings page is opened instead.
 */
export async function installApkUpdate(release: ApkRelease): Promise<boolean> {
  if (!appUpdate) return false;
  if (!appUpdate.canInstall()) {
    appUpdate.openInstallSettings();
    return false;
  }
  await appUpdate.downloadAndInstall(release.apkUrl);
  return true;
}
