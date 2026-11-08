import { describe, expect, it } from "vite-plus/test";

import { shouldOfferBatteryHint, vendorGuideUrl, vendorName } from "./batteryGuidance";

describe("vendorGuideUrl", () => {
  it("links makers with a known guide page", () => {
    expect(vendorGuideUrl("OnePlus")).toBe("https://dontkillmyapp.com/oneplus");
    expect(vendorGuideUrl(" samsung ")).toBe("https://dontkillmyapp.com/samsung");
    expect(vendorGuideUrl("HMD Global")).toBe("https://dontkillmyapp.com/nokia");
  });

  it("gives no link for makers without a checked page", () => {
    expect(vendorGuideUrl("Honor")).toBeNull();
    expect(vendorGuideUrl("Fairphone")).toBeNull();
    expect(vendorGuideUrl("")).toBeNull();
    expect(vendorGuideUrl(undefined)).toBeNull();
  });
});

describe("vendorName", () => {
  it("names the maker for display", () => {
    expect(vendorName("OnePlus")).toBe("OnePlus");
    expect(vendorName("oneplus")).toBe("OnePlus");
    expect(vendorName("samsung")).toBe("Samsung");
    expect(vendorName(undefined)).toBe("your phone");
  });
});

describe("shouldOfferBatteryHint", () => {
  it("asks only while optimised and not answered before", () => {
    expect(shouldOfferBatteryHint({ optimized: true, hintDismissed: false })).toBe(true);
    expect(shouldOfferBatteryHint({ optimized: true, hintDismissed: true })).toBe(false);
    expect(shouldOfferBatteryHint({ optimized: false, hintDismissed: false })).toBe(false);
    expect(shouldOfferBatteryHint(null)).toBe(false);
  });
});
