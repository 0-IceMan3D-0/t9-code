const { withAppBuildGradle } = require("expo/config-plugins");

// expo-image caches drawables under the versionCode, and resource ids shift between builds,
// so a fixed versionCode shows another build's pictures. Minutes since epoch always grow.
const VERSION_CODE = "versionCode((int) (System.currentTimeMillis() / 60000L))";

module.exports = function withAndroidBuildTimeVersionCode(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    nextConfig.modResults.contents = nextConfig.modResults.contents.replace(
      /^(\s*)versionCode .*$/m,
      `$1${VERSION_CODE}`,
    );
    return nextConfig;
  });
};
