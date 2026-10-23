import type { PullProgressEvent } from "@nemesis-oss/ollama-sdk";

/**
 * One line per registry pull progress frame, e.g.
 * `downloading · 42.4% · 11.3 MB/s · ETA 1m 04s`. Fields the SDK did not
 * measure yet (speed needs two byte-bearing frames of a layer) are omitted
 * rather than printed as zeros.
 */
export function formatPullProgress(event: PullProgressEvent): string {
  const parts: string[] = [event.status];
  if (event.percent !== undefined) parts.push(`${event.percent.toFixed(1)}%`);
  if (event.bytesPerSecond !== undefined) parts.push(`${formatBytes(event.bytesPerSecond)}/s`);
  if (event.etaSeconds !== undefined) parts.push(`ETA ${formatDuration(event.etaSeconds)}`);
  return parts.join(" · ");
}

/** Decimal (SI) units, matching how registry sizes and transfer rates are quoted. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}
