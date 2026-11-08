import { formatBytes } from "../../lib/formatBytes";
import type { HealthSample, StorageSample } from "./localServerModule";

/** Share of the whole phone's CPU the tree used between two samples, or null without a baseline. */
export function cpuPercent(previous: HealthSample | null, next: HealthSample): number | null {
  if (!previous) return null;
  const seconds = (next.at - previous.at) / 1000;
  if (seconds <= 0 || next.ticksPerSecond <= 0 || next.cores <= 0) return null;
  // Processes that exited take their ticks with them, so the sum can drop.
  const ticks = Math.max(0, next.cpuTicks - previous.cpuTicks);
  return Math.min(100, (ticks / next.ticksPerSecond / seconds / next.cores) * 100);
}

export function describeMemory(sample: HealthSample): string {
  const processes = sample.processes === 1 ? "1 process" : `${sample.processes} processes`;
  if (sample.processes === 0) {
    return `Linux is not running · ${formatBytes(sample.availableMemory)} of ${formatBytes(sample.totalMemory)} free on the phone`;
  }
  return `Linux uses ${formatBytes(sample.rssBytes)} in ${processes} · ${formatBytes(sample.availableMemory)} of ${formatBytes(sample.totalMemory)} free on the phone`;
}

export function describeCpu(percent: number | null, sample: HealthSample): string {
  if (sample.processes === 0) return "Idle";
  if (percent === null) return "Measuring…";
  const shown = percent > 0 && percent < 1 ? "<1" : Math.round(percent).toString();
  return `${shown}% of the phone's ${sample.cores} cores`;
}

export function describeStorage(storage: StorageSample): string {
  return `Linux ${formatBytes(storage.linuxBytes)} · private projects ${formatBytes(storage.projectBytes)} · ${formatBytes(storage.freeBytes)} free on the phone`;
}

export function healthWarning(sample: HealthSample): string | null {
  switch (sample.warning) {
    case "deviceLow":
      return `The phone is low on memory (${formatBytes(sample.availableMemory)} free). Android may stop the built-in server and its agents. Close other apps or stop agents you don't need.`;
    case "treeLarge":
      return `Linux is using ${formatBytes(sample.rssBytes)}, a large share of the phone's ${formatBytes(sample.totalMemory)}. Android may stop it to free memory. Stop agents or programs you don't need.`;
    case null:
      return null;
  }
}
