/**
 * How token counts and limits are written and typed on screen, for the
 * operator's Token limits page and the limits card on My usage. Pure, and
 * free of the settings package (which reaches the database), so client
 * components can use it.
 */

/** 1,234,567 → "1.2M"; exact below a thousand. */
export function formatTokens(tokens: number): string {
  const short = (value: number, unit: string) =>
    `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
  if (tokens >= 1_000_000_000) return short(tokens / 1_000_000_000, 'B');
  if (tokens >= 1_000_000) return short(tokens / 1_000_000, 'M');
  if (tokens >= 1_000) return short(tokens / 1_000, 'K');
  return String(Math.max(0, Math.round(tokens)));
}

const UNITS: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
const MAX_TOKENS = 1_000_000_000_000;

/**
 * A typed amount of tokens: "2M", "500k", "1.5 m", "1,500,000". Blank is 0
 * (which, for a limit, is no limit). Null when the text is not an amount.
 */
export function parseTokens(text: string): number | null {
  const trimmed = text.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  if (trimmed === '') return 0;
  const match = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(trimmed);
  if (!match) return null;
  const value = Math.round(Number(match[1]) * (match[2] ? UNITS[match[2]] : 1));
  return Number.isFinite(value) && value <= MAX_TOKENS ? value : null;
}

/** A stored limit as the text its field starts with: "" for none, else the shortest exact form. */
export function tokensFieldText(tokens: number): string {
  if (tokens <= 0) return '';
  for (const [unit, size] of [
    ['B', 1_000_000_000],
    ['M', 1_000_000],
    ['K', 1_000],
  ] as const) {
    // Up to two decimals keeps the text exact ("1.25M"); anything finer is written out.
    if (tokens >= size && (tokens * 100) % size === 0) return `${tokens / size}${unit}`;
  }
  return String(tokens);
}

export interface LimitProgress {
  /** The limit in force, boost included; null when nothing limits this. */
  limit: number | null;
  used: number;
  /** How full the bar is, 0–100. */
  percent: number;
  /** At or past the limit: nothing new starts. */
  reached: boolean;
  /** Within a fifth of the limit. */
  near: boolean;
  /** "350K of 1M", or "350K used" with no limit. */
  label: string;
}

export function limitProgress(used: number, limit: number | null, boost = 0): LimitProgress {
  if (limit === null || limit <= 0) {
    return {
      limit: null,
      used,
      percent: 0,
      reached: false,
      near: false,
      label: `${formatTokens(used)} used`,
    };
  }
  const inForce = limit + boost;
  const share = used / inForce;
  return {
    limit: inForce,
    used,
    percent: Math.min(100, Math.round(share * 100)),
    reached: used >= inForce,
    near: used < inForce && share >= 0.8,
    label: `${formatTokens(used)} of ${formatTokens(inForce)}`,
  };
}

/** "Mon 16 Nov, 00:00 UTC": limits reset on the organization's clock, so the zone is always said. */
export function formatReset(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const two = (value: number) => String(value).padStart(2, '0');
  return `${days[at.getUTCDay()]} ${at.getUTCDate()} ${months[at.getUTCMonth()]}, ${two(
    at.getUTCHours()
  )}:${two(at.getUTCMinutes())} UTC`;
}
