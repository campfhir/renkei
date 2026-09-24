/**
 * A duration as a person reads it beside a step: "0.4s", "12s", "1m 05s",
 * "1h 02m". Tenths only under a second — past that a whole second is as
 * exact as anyone wants on a line that says where a reply's time went.
 */
export function formatDurationMs(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 1000) return `${(clamped / 1000).toFixed(1)}s`;
  const seconds = Math.round(clamped / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
