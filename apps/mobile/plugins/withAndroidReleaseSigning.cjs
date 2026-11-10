const { withAppBuildGradle } = require("expo/config-plugins");

// Release builds are signed with the key named by T9_KEYSTORE_PATH and the T9_* variables, so
// local and GitHub builds can update each other. Without it they fall back to the debug key.
const SIGNING_CONFIG = `
        release {
            def keystore = System.getenv('T9_KEYSTORE_PATH')
            if (keystore) {
                storeFile file(keystore)
                storePassword System.getenv('T9_KEYSTORE_PASSWORD')
                keyAlias System.getenv('T9_KEY_ALIAS')
                keyPassword System.getenv('T9_KEY_PASSWORD')
            }
        }`;

function withReleaseSigning(contents) {
  if (contents.includes("T9_KEYSTORE_PATH")) return contents;
  const withConfig = contents.replace(/^(\s*signingConfigs \{)$/m, `$1${SIGNING_CONFIG}`);
  // The second `signingConfig signingConfigs.debug` is the release build type's.
  let seen = 0;
  const result = withConfig.replace(/signingConfig signingConfigs\.debug/g, (match) =>
    ++seen === 2
      ? "signingConfig System.getenv('T9_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug"
      : match,
  );
  if (result === contents || seen < 2) {
    throw new Error(
      "withAndroidReleaseSigning: app/build.gradle no longer has the expected signing setup",
    );
  }
  return result;
}

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    nextConfig.modResults.contents = withReleaseSigning(nextConfig.modResults.contents);
    return nextConfig;
  });
};
module.exports.withReleaseSigning = withReleaseSigning;
