const {
  AndroidConfig,
  withAndroidManifest,
  withAndroidStyles,
  withMainActivity,
} = require("expo/config-plugins");

const PRESETS = require("../modules/t3-app-icon/presets.json");

// The launcher entry lives only on activity aliases, one per preset, so T3AppIcon can switch the
// icon by enabling one alias. Deep links, share and notification intents stay on MainActivity.
// "classic" keeps the icon Expo generates from app.config; the others ship in modules/t3-app-icon.

const isLauncherFilter = (filter) =>
  (filter.action ?? []).some((a) => a.$["android:name"] === "android.intent.action.MAIN") &&
  (filter.category ?? []).some((c) => c.$["android:name"] === "android.intent.category.LAUNCHER");

// Launch splash. Aliases cannot carry a theme, so MainActivity's manifest theme has no icon: on
// Android 12 the system then draws the launched alias's icon, and below 12 the window shows only
// the background until AppIconStyle.applyLaunchTheme sets the preset's theme. On 13+ that call
// persists the preset's theme with SplashScreen.setSplashScreenTheme for every later launch.
const LAUNCH_THEME = "T3LaunchTheme";
const APPLY_LAUNCH_THEME = "expo.modules.t3appicon.AppIconStyle.applyLaunchTheme(this)";
const ON_CREATE = "override fun onCreate(savedInstanceState: Bundle?) {";

const style = (name, parent, icon) => ({
  $: { name, parent },
  item: [
    { $: { name: "windowSplashScreenAnimatedIcon" }, _: icon.compat },
    { $: { name: "android:windowSplashScreenAnimatedIcon" }, _: icon.platform },
  ],
});

function launchStyles() {
  return [
    style(LAUNCH_THEME, "Theme.App.SplashScreen", {
      compat: "@android:color/transparent",
      platform: "@null",
    }),
    ...PRESETS.map(({ id }) => {
      const drawable =
        id === "classic" ? "@drawable/splashscreen_logo" : `@drawable/t3_splash_${id}`;
      return style(`${LAUNCH_THEME}_${id}`, LAUNCH_THEME, { compat: drawable, platform: drawable });
    }),
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
  config = withMainActivity(config, (nextConfig) => {
    const contents = nextConfig.modResults.contents;
    if (contents.includes(APPLY_LAUNCH_THEME)) return nextConfig;
    const index = contents.indexOf(ON_CREATE);
    if (index === -1) {
      throw new Error(
        "withAndroidAppIcons: MainActivity has no onCreate(savedInstanceState: Bundle?).",
      );
    }
    const end = index + ON_CREATE.length;
    nextConfig.modResults.contents = `${contents.slice(0, end)}
    // Before the splash screen is installed; added by withAndroidAppIcons.
    ${APPLY_LAUNCH_THEME}${contents.slice(end)}`;
    return nextConfig;
  });
  return withAndroidManifest(config, (nextConfig) => {
    const manifest = nextConfig.modResults;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    mainActivity.$["android:theme"] = `@style/${LAUNCH_THEME}`;
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
