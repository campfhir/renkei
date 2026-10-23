/** 1234 → "1.2k", 1234567 → "1.2M"; small numbers as they are. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

/**
 * The inverse of formatTokens for a typed count: "200k" → 200000,
 * "1m" → 1000000, "1.5M" → 1500000, "200,000" → 200000, "200000" → 200000.
 * Null for anything that is not a positive whole number of tokens once
 * scaled, so the caller can say what it expects rather than guess.
 */
export function parseTokenCount(input: string): number | null {
  const match = /^(\d+(?:\.\d+)?|\.\d+)([km])?$/.exec(input.replace(/[,_\s]/g, '').toLowerCase());
  if (!match || (!match[2] && match[1].includes('.'))) return null;
  const scale = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  const tokens = Math.round(Number(match[1]) * scale);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}
