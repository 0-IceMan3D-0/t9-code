import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { AndroidConfig, compileModsAsync, XML } from "expo/config-plugins";
import { afterEach, describe, expect, it } from "vite-plus/test";

import PRESETS from "../modules/t3-app-icon/presets.json";
import withAndroidAppIcons from "./withAndroidAppIcons.cjs";

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:name=".MainApplication">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.SEND"/>
        <data android:mimeType="*/*"/>
        <category android:name="android.intent.category.DEFAULT"/>
      </intent-filter>
    </activity>
  </application>
</manifest>`;

const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

async function prebuildAndroid(manifest = MANIFEST) {
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "app-icons-"));
  projectRoots.push(projectRoot);
  const manifestPath = NodePath.join(projectRoot, "android/app/src/main/AndroidManifest.xml");
  NodeFS.mkdirSync(NodePath.dirname(manifestPath), { recursive: true });
  NodeFS.writeFileSync(manifestPath, manifest);
  await compileModsAsync(withAndroidAppIcons({ name: "T3 Code", slug: "t3code" }), {
    projectRoot,
    platforms: ["android"],
  });
  return NodeFS.readFileSync(manifestPath, "utf8");
}

describe("withAndroidAppIcons", () => {
  it("moves the launcher entry to one enabled alias per preset and stays stable on repeated prebuild", async () => {
    const once = await prebuildAndroid();
    const parsed = (await XML.parseXMLAsync(once)) as AndroidConfig.Manifest.AndroidManifest;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(parsed);
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(parsed);
    const aliases = application["activity-alias"] ?? [];

    expect(
      mainActivity["intent-filter"]?.map((filter) => filter.action?.[0]?.$["android:name"]),
    ).toEqual(["android.intent.action.SEND"]);
    expect(aliases.map((alias) => alias.$?.["android:name"])).toEqual(
      PRESETS.map((preset) => `.appicon.${preset.id}`),
    );
    expect(
      aliases
        .filter((alias) => alias.$?.["android:enabled"] === "true")
        .map((alias) => alias.$?.["android:name"]),
    ).toEqual([".appicon.classic"]);
    expect(aliases.every((alias) => alias.$?.["android:targetActivity"] === ".MainActivity")).toBe(
      true,
    );
    expect(await prebuildAndroid(once)).toEqual(once);
  });
});
