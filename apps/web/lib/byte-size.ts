const KB = 1_024;
const MB = 1_048_576;
const GB = 1_073_741_824;

const UNITS: Record<string, number> = { b: 1, kb: KB, mb: MB, gb: GB };

/**
 * A size typed as a person writes it: "70MB", "2 GB", "512kb", or a bare
 * byte count. Units are binary, matching the rest of the app (1MB is
 * 1,048,576 bytes). Null when the text is not a size, or is not a whole
 * byte count.
 */
export function parseByteSize(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?b)?\s*$/i.exec(text);
  if (!match) return null;
  const unit = UNITS[(match[2] ?? 'b').toLowerCase()];
  const bytes = Math.round(Number(match[1]) * unit);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/** The largest unit the byte count divides into evenly: 73400320 is "70MB". */
export function formatByteSize(bytes: number): string {
  if (bytes >= GB && bytes % GB === 0) return `${bytes / GB}GB`;
  if (bytes >= MB && bytes % MB === 0) return `${bytes / MB}MB`;
  if (bytes >= KB && bytes % KB === 0) return `${bytes / KB}KB`;
  return `${bytes}`;
}
