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

const MAIN_ACTIVITY = `package com.example
class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    SplashScreenManager.registerOnActivity(this)
    super.onCreate(null)
  }
}
`;

const STYLES = `<resources>
  <style name="Theme.App.SplashScreen" parent="Theme.SplashScreen"/>
</resources>
`;

const projectRoots: string[] = [];

afterEach(() => {
  for (const root of projectRoots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

async function prebuildAndroid(
  files: { manifest: string; mainActivity: string; styles: string } = {
    manifest: MANIFEST,
    mainActivity: MAIN_ACTIVITY,
    styles: STYLES,
  },
) {
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "app-icons-"));
  projectRoots.push(projectRoot);
  const main = NodePath.join(projectRoot, "android/app/src/main");
  const paths = {
    manifest: NodePath.join(main, "AndroidManifest.xml"),
    mainActivity: NodePath.join(main, "java/com/example/MainActivity.kt"),
    styles: NodePath.join(main, "res/values/styles.xml"),
  };
  for (const key of ["manifest", "mainActivity", "styles"] as const) {
    NodeFS.mkdirSync(NodePath.dirname(paths[key]), { recursive: true });
    NodeFS.writeFileSync(paths[key], files[key]);
  }
  await compileModsAsync(
    withAndroidAppIcons({ name: "T3 Code", slug: "t3code", android: { package: "com.example" } }),
    { projectRoot, platforms: ["android"] },
  );
  return {
    manifest: NodeFS.readFileSync(paths.manifest, "utf8"),
    mainActivity: NodeFS.readFileSync(paths.mainActivity, "utf8"),
    styles: NodeFS.readFileSync(paths.styles, "utf8"),
  };
}

describe("withAndroidAppIcons", () => {
  it("moves the launcher entry to one enabled alias per preset and stays stable on repeated prebuild", async () => {
    const once = await prebuildAndroid();
    const parsed = (await XML.parseXMLAsync(
      once.manifest,
    )) as AndroidConfig.Manifest.AndroidManifest;
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

  it("launches with an icon-less splash theme and applies the preset's theme before the splash installs", async () => {
    const { manifest, mainActivity, styles } = await prebuildAndroid();
    const parsed = (await XML.parseXMLAsync(manifest)) as AndroidConfig.Manifest.AndroidManifest;
    expect(AndroidConfig.Manifest.getMainActivityOrThrow(parsed).$["android:theme"]).toBe(
      "@style/T3LaunchTheme",
    );
    const apply = mainActivity.indexOf("AppIconStyle.applyLaunchTheme(this)");
    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(mainActivity.indexOf("SplashScreenManager.registerOnActivity"));

    const parsedStyles = (await XML.parseXMLAsync(styles)) as {
      resources: {
        style: Array<{
          $: { name: string; parent?: string };
          item?: Array<{ $: { name: string }; _: string }>;
        }>;
      };
    };
    const icons = Object.fromEntries(
      parsedStyles.resources.style.map((entry) => [
        entry.$.name,
        Object.fromEntries((entry.item ?? []).map((item) => [item.$.name, item._])),
      ]),
    );
    expect(icons.T3LaunchTheme?.["android:windowSplashScreenAnimatedIcon"]).toBe("@null");
    for (const { id } of PRESETS) {
      expect(icons[`T3LaunchTheme_${id}`]?.["android:windowSplashScreenAnimatedIcon"]).toBe(
        id === "classic" ? "@drawable/splashscreen_logo" : `@drawable/t3_splash_${id}`,
      );
    }
  });
});
