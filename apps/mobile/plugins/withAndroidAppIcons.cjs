const { AndroidConfig, withAndroidManifest, withAndroidStyles } = require("expo/config-plugins");

const PRESETS = require("../modules/t3-app-icon/presets.json");

// The launcher entry lives only on activity aliases, one per preset, so T3AppIcon can switch the
// icon by enabling one alias. Deep links, share and notification intents stay on MainActivity.
// "classic" keeps the icon Expo generates from app.config; the others ship in modules/t3-app-icon.

// Also the application icon: One UI draws that on notification cards whichever alias is enabled.
const DEFAULT_PRESET = "original";

const isLauncherFilter = (filter) =>
  (filter.action ?? []).some((a) => a.$["android:name"] === "android.intent.action.MAIN") &&
  (filter.category ?? []).some((c) => c.$["android:name"] === "android.intent.category.LAUNCHER");

// Launch splash. Aliases cannot carry a theme, so MainActivity's manifest theme has no icon:
// Android 12 then draws the launched alias's icon, and older versions only the background (the
// window is drawn before any app code runs). On 13+ AppIconStyle persists the preset's
// T3LaunchTheme_<id> with SplashScreen.setSplashScreenTheme, which every later launch uses.
const LAUNCH_THEME = "T3LaunchTheme";

const icon = (name, value) => ({ $: { name }, _: value });

function launchStyles() {
  return [
    {
      $: { name: LAUNCH_THEME, parent: "Theme.App.SplashScreen" },
      item: [
        icon("windowSplashScreenAnimatedIcon", "@android:color/transparent"),
        icon("android:windowSplashScreenAnimatedIcon", "@null"),
      ],
    },
    ...PRESETS.map(({ id }) => ({
      $: { name: `${LAUNCH_THEME}_${id}`, parent: LAUNCH_THEME },
      item: [
        icon(
          "android:windowSplashScreenAnimatedIcon",
          id === "classic" ? "@drawable/splashscreen_logo" : `@drawable/t3_splash_${id}`,
        ),
      ],
    })),
  ];
}

module.exports = function withAndroidAppIcons(config) {
  config = withAndroidStyles(config, (nextConfig) => {
    const resources = nextConfig.modResults.resources;
    resources.style = [
      ...(resources.style ?? []).filter(({ $ }) => !$.name.startsWith(LAUNCH_THEME)),
      ...launchStyles(),
    ];
    return nextConfig;
  });
  return withAndroidManifest(config, (nextConfig) => {
    const manifest = nextConfig.modResults;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    mainActivity.$["android:theme"] = `@style/${LAUNCH_THEME}`;
    application.$["android:icon"] = `@mipmap/t3_icon_${DEFAULT_PRESET}`;
    application.$["android:roundIcon"] = `@mipmap/t3_icon_${DEFAULT_PRESET}_round`;
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
            "android:enabled": id === DEFAULT_PRESET ? "true" : "false",
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
