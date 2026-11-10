import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

const { parseRelease } = await import("./apkUpdates");

const asset = { name: "t9-code.apk", browser_download_url: "https://example.com/t9-code.apk" };

describe("parseRelease", () => {
  it("reads the build number from the tag and the APK from the assets", () => {
    expect(
      parseRelease({ tag_name: "b29384756", name: "Build 29384756", assets: [asset] }),
    ).toEqual({
      versionCode: 29384756,
      title: "Build 29384756",
      apkUrl: "https://example.com/t9-code.apk",
    });
  });

  it("ignores releases that are not app builds", () => {
    expect(parseRelease({ tag_name: "v0.1.8-nightly", assets: [asset] })).toBeNull();
    expect(parseRelease({ tag_name: "b123", assets: [{ name: "notes.txt" }] })).toBeNull();
    expect(parseRelease({ message: "Not Found" })).toBeNull();
  });
});
