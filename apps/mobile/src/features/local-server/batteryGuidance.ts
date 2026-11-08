import type { BatteryState } from "./localServerModule";

// Pages checked to exist on dontkillmyapp.com (2026-11-08); other makers get no link.
const VENDOR_GUIDES = new Set([
  "asus",
  "blackview",
  "google",
  "huawei",
  "lenovo",
  "meizu",
  "motorola",
  "nokia",
  "oneplus",
  "oppo",
  "realme",
  "samsung",
  "sony",
  "tecno",
  "unihertz",
  "vivo",
  "wiko",
  "xiaomi",
]);
const VENDOR_ALIASES: Readonly<Record<string, string>> = { "hmd global": "nokia" };

export function vendorGuideUrl(manufacturer: string | undefined): string | null {
  const key = manufacturer?.trim().toLowerCase() ?? "";
  const vendor = VENDOR_ALIASES[key] ?? key;
  return VENDOR_GUIDES.has(vendor) ? `https://dontkillmyapp.com/${vendor}` : null;
}

export function vendorName(manufacturer: string | undefined): string {
  const name = manufacturer?.trim() ?? "";
  if (name.toLowerCase() === "oneplus") return "OnePlus";
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : "your phone";
}

export function shouldOfferBatteryHint(state: BatteryState | null): boolean {
  return state !== null && state.optimized && !state.hintDismissed;
}

export const BATTERY_REASON =
  "OnePlus and other phones stop background work of apps under battery optimisation, even behind a notification. Agents then stop in the middle of a run.";
