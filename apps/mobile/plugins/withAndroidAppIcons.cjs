const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

const PRESETS = require("../modules/t3-app-icon/presets.json");

// The launcher entry lives only on activity aliases, one per preset, so T3AppIcon can switch the
// icon by enabling one alias. Deep links, share and notification intents stay on MainActivity.
// "classic" keeps the icon Expo generates from app.config; the others ship in modules/t3-app-icon.

const isLauncherFilter = (filter) =>
  (filter.action ?? []).some((a) => a.$["android:name"] === "android.intent.action.MAIN") &&
  (filter.category ?? []).some((c) => c.$["android:name"] === "android.intent.category.LAUNCHER");

module.exports = function withAndroidAppIcons(config) {
  return withAndroidManifest(config, (nextConfig) => {
    const manifest = nextConfig.modResults;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    mainActivity["intent-filter"] = (mainActivity["intent-filter"] ?? []).filter(
      (filter) => !isLauncherFilter(filter),
    );
    const others = (application["activity-alias"] ?? []).filter(
      (alias) => !alias.$["android:name"].startsWith(".appicon."),
    );
    application["activity-alias"] = [
      ...others,
      ...PRESETS.map(({ id }) => {
        const icon = id === "classic" ? "@mipmap/ic_launcher" : `@mipmap/t3_icon_${id}`;
        const roundIcon =
          id === "classic" ? "@mipmap/ic_launcher_round" : `@mipmap/t3_icon_${id}_round`;
        return {
          $: {
            "android:name": `.appicon.${id}`,
            "android:targetActivity": mainActivity.$["android:name"],
            "android:enabled": id === "classic" ? "true" : "false",
            "android:exported": "true",
            "android:icon": icon,
            "android:roundIcon": roundIcon,
          },
          "intent-filter": [
            {
              action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
              category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }],
            },
          ],
        };
      }),
    ];
    return nextConfig;
  });
};
