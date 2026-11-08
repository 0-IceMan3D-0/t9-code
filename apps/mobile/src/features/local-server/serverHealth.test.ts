import { describe, expect, it } from "vite-plus/test";

import type { HealthSample } from "./localServerModule";
import { cpuPercent, describeCpu, describeMemory, healthWarning } from "./serverHealth";

const GB = 1024 ** 3;
const sample = (overrides: Partial<HealthSample>): HealthSample => ({
  at: 10_000,
  rssBytes: 512 * 1024 ** 2,
  cpuTicks: 1000,
  ticksPerSecond: 100,
  cores: 8,
  processes: 4,
  totalMemory: 12 * GB,
  availableMemory: 6 * GB,
  warning: null,
  ...overrides,
});

describe("cpuPercent", () => {
  it("needs a baseline", () => {
    expect(cpuPercent(null, sample({}))).toBeNull();
  });

  it("measures ticks against wall time and every core", () => {
    // 400 ticks at 100 Hz over 2 s on 8 cores: 2 core-seconds of 16.
    expect(cpuPercent(sample({}), sample({ at: 12_000, cpuTicks: 1400 }))).toBe(25);
  });

  it("never goes negative when a process exits, and caps at 100", () => {
    expect(cpuPercent(sample({}), sample({ at: 12_000, cpuTicks: 200 }))).toBe(0);
    expect(cpuPercent(sample({}), sample({ at: 11_000, cpuTicks: 100_000 }))).toBe(100);
    expect(cpuPercent(sample({}), sample({}))).toBeNull();
  });
});

describe("describe", () => {
  it("summarises memory and CPU", () => {
    expect(describeMemory(sample({}))).toBe(
      "Linux uses 512 MB in 4 processes · 6.0 GB of 12.0 GB free on the phone",
    );
    expect(describeMemory(sample({ processes: 0 }))).toBe(
      "Linux is not running · 6.0 GB of 12.0 GB free on the phone",
    );
    expect(describeCpu(0.4, sample({}))).toBe("<1% of the phone's 8 cores");
    expect(describeCpu(null, sample({}))).toBe("Measuring…");
    expect(describeCpu(null, sample({ processes: 0 }))).toBe("Idle");
  });

  it("explains each warning", () => {
    expect(healthWarning(sample({}))).toBeNull();
    expect(healthWarning(sample({ warning: "deviceLow", availableMemory: GB }))).toContain(
      "low on memory (1.0 GB free)",
    );
    expect(healthWarning(sample({ warning: "treeLarge", rssBytes: 6 * GB }))).toContain(
      "Linux is using 6.0 GB",
    );
  });
});
