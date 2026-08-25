/**
 * What the insert menu offers — tools and variables flattened into one
 * option shape, built once per builder render from the server-fetched
 * catalog and the draft's current triggers/saveAs names.
 */

import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { describeDateSegment, type DateSegment, type VariableDescriptor } from '@renkei/agents';
import { friendlyToolName } from '@/lib/tool-name';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';

export interface ToolOption {
  kind: 'tool';
  name: string;
  label: string;
  description: string;
  /** Connector display label, for grouping. */
  group: string;
  connector: string | null;
}

export interface VariableOption {
  kind: 'var';
  name: string;
  label: string;
  description: string;
}

/**
 * A date the RUNTIME computes, inserted as a chip rather than typed out.
 *
 * The chip carries the intent (how far, which unit, which zone) and is
 * resolved to a literal instant when the step's prompt is built — so the
 * model never does the arithmetic, and a step written today still means
 * "yesterday" when it runs next month.
 */
export interface DateOption {
  kind: 'date';
  /** Menu identity; the chip's meaning lives in `segment`. */
  name: string;
  label: string;
  description: string;
  segment: DateSegment;
}

export type InsertOption = ToolOption | VariableOption | DateOption;

/**
 * The presets the `/` menu offers, in the caller's own timezone — which is
 * the one thing this cannot infer and the model must not guess.
 *
 * Deliberately a short list of the things people actually write into
 * instructions. Anything more specific is a preset plus a hand edit, which
 * is better than a menu nobody can scan.
 */
/**
 * A date the user TYPED, turned into an exact chip: "30 minutes ago",
 * "4h ago", "in 2 weeks", "yesterday at 19:00".
 *
 * Presets cannot cover every number anyone will want, and a menu that tried
 * would be unscannable. Parsing the query instead means the list stays
 * short while any value remains one keystroke away.
 */
export function parseDateQuery(timezone: string, query: string): DateOption | null {
  const text = query.trim().toLowerCase();
  if (!text) return null;

  // "at HH:MM" may ride along with any of the forms below.
  const timeMatch = /\bat\s+([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(text);
  const atTime = timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : undefined;
  const body = timeMatch ? text.replace(timeMatch[0], ' ').trim() : text;

  const named: Record<string, { amount: number; unit: DateSegment['unit'] }> = {
    today: { amount: 0, unit: 'day' },
    now: { amount: 0, unit: 'minute' },
    yesterday: { amount: -1, unit: 'day' },
    tomorrow: { amount: 1, unit: 'day' },
  };
  const namedHit = named[body];

  // "30 minutes ago" / "4h ago" / "in 2 weeks" / "2 weeks from now".
  const UNITS: [RegExp, DateSegment['unit']][] = [
    [/^(?:min|mins|minute|minutes|m)$/, 'minute'],
    [/^(?:h|hr|hrs|hour|hours)$/, 'hour'],
    [/^(?:d|day|days)$/, 'day'],
    [/^(?:w|wk|wks|week|weeks)$/, 'week'],
    [/^(?:mo|mon|month|months)$/, 'month'],
    [/^(?:y|yr|yrs|year|years)$/, 'year'],
  ];
  const quantified =
    /^(?:in\s+)?(\d{1,4})\s*([a-z]+)(?:\s+(ago|back|from\s+now|ahead|later))?$/.exec(body);

  let amount: number;
  let unit: DateSegment['unit'];
  if (namedHit) {
    ({ amount, unit } = namedHit);
  } else if (quantified) {
    const found = UNITS.find(([pattern]) => pattern.test(quantified[2]));
    if (!found) return null;
    unit = found[1];
    const past = !quantified[3] || quantified[3] === 'ago' || quantified[3] === 'back';
    // "in 2 weeks" reads forward even without a trailing word.
    const forward = body.startsWith('in ') || (quantified[3] !== undefined && !past);
    amount = Number(quantified[1]) * (forward ? 1 : -1);
  } else {
    return null;
  }

  const segment: DateSegment = {
    t: 'date',
    amount,
    unit,
    timezone,
    ...(atTime ? { atTime } : {}),
    // A whole-day chip with no time reads better as a date; anything with a
    // time of day, or a sub-day unit, wants the exact instant.
    ...(!atTime && (unit === 'day' || unit === 'week' || unit === 'month' || unit === 'year')
      ? { format: 'date' as const }
      : {}),
  };
  return {
    kind: 'date',
    name: query.trim(),
    label: describeDateSegment(segment),
    description: 'Computed when the agent runs.',
    segment,
  };
}

export function dateOptions(timezone: string, query = ''): DateOption[] {
  const typed = parseDateQuery(timezone, query);
  const presets = basePresets(timezone);
  if (!typed) return presets;
  // The typed one first, and never duplicated by a preset that means the
  // same thing.
  return [
    typed,
    ...presets.filter((preset) => JSON.stringify(preset.segment) !== JSON.stringify(typed.segment)),
  ];
}

function basePresets(timezone: string): DateOption[] {
  const make = (
    name: string,
    label: string,
    description: string,
    segment: Omit<DateSegment, 'timezone'>
  ): DateOption => ({
    kind: 'date',
    name,
    label,
    description,
    segment: { ...segment, timezone },
  });
  return [
    make('today', 'Today', 'The date this runs, in your timezone.', {
      t: 'date',
      amount: 0,
      unit: 'day',
      format: 'date',
    }),
    make('yesterday', 'Yesterday', 'The day before this runs.', {
      t: 'date',
      amount: -1,
      unit: 'day',
      format: 'date',
    }),
    make('tomorrow', 'Tomorrow', 'The day after this runs.', {
      t: 'date',
      amount: 1,
      unit: 'day',
      format: 'date',
    }),
    make('start of today', 'Start of today', 'Midnight this morning, as an exact instant.', {
      t: 'date',
      amount: 0,
      unit: 'day',
      boundary: 'start',
    }),
    make(
      'yesterday 19:00',
      'Yesterday at 19:00',
      'Yesterday evening — edit the time after inserting.',
      {
        t: 'date',
        amount: -1,
        unit: 'day',
        atTime: '19:00',
      }
    ),
    make('15 minutes ago', '15 minutes ago', 'A quarter hour of elapsed time.', {
      t: 'date',
      amount: -15,
      unit: 'minute',
    }),
    make('30 minutes ago', '30 minutes ago', 'Half an hour of elapsed time.', {
      t: 'date',
      amount: -30,
      unit: 'minute',
    }),
    make('1 hour ago', 'An hour ago', 'Exactly 60 minutes before this runs.', {
      t: 'date',
      amount: -1,
      unit: 'hour',
    }),
    make('4 hours ago', '4 hours ago', 'Exactly four hours of elapsed time.', {
      t: 'date',
      amount: -4,
      unit: 'hour',
    }),
    make('24 hours ago', '24 hours ago', 'Exactly a day of elapsed time before this runs.', {
      t: 'date',
      amount: -24,
      unit: 'hour',
    }),
    make('7 days ago', '7 days ago', 'A week back, same time of day.', {
      t: 'date',
      amount: -7,
      unit: 'day',
    }),
    make('start of this week', 'Start of this week', 'Midnight on Sunday of this week.', {
      t: 'date',
      amount: 0,
      unit: 'week',
      boundary: 'start',
    }),
    make('start of this month', 'Start of this month', 'Midnight on the 1st.', {
      t: 'date',
      amount: 0,
      unit: 'month',
      boundary: 'start',
    }),
  ];
}

const connectorLabels = new Map(
  CONNECTOR_CATALOG.map((entry) => [entry.capabilityKey, entry.label])
);

export function toToolOptions(tools: ToolDescriptor[]): ToolOption[] {
  return tools
    .filter((tool) => !tool.appOnly)
    .map((tool) => ({
      kind: 'tool' as const,
      name: tool.name,
      label: friendlyToolName(tool.name, tool.title),
      description: tool.description ?? '',
      group: (tool.connector && connectorLabels.get(tool.connector)) || 'Other',
      connector: tool.connector,
    }));
}

export function toVariableOptions(variables: VariableDescriptor[]): VariableOption[] {
  return variables.map((variable) => ({
    kind: 'var' as const,
    name: variable.name,
    label: variable.label,
    description: variable.description,
  }));
}

/** True when `word` appears as a subsequence of `text` (j, r, a → "jira"). */
function subsequence(word: string, text: string): boolean {
  let at = 0;
  for (const char of text) {
    if (char === word[at]) at += 1;
    if (at === word.length) return true;
  }
  return false;
}

/**
 * Relevance of an option for a query, or null for no match. Deliberately
 * NOT exact-substring-in-order: the query splits into words, every word
 * may hit anywhere (label, wire name, description) in any order, and a
 * longer word may match as a subsequence — "comment jira" finds "Jira ·
 * Add a comment" as readily as the reverse. Prefix and word-boundary hits
 * on the label outrank buried ones, so the list reads best-first.
 */
export function scoreOption(option: InsertOption, query: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const label = option.label.toLowerCase();
  const name = option.name.toLowerCase();
  const description = option.description.toLowerCase();

  let total = 0;
  for (const word of words) {
    let best = 0;
    if (label.startsWith(word)) best = 30;
    else if (label.includes(` ${word}`)) best = 20;
    else if (label.includes(word)) best = 12;
    else if (name.includes(word)) best = 8;
    else if (description.includes(word)) best = 4;
    else if (word.length >= 3 && subsequence(word, label)) best = 2;
    if (best === 0) return null; // every word must land somewhere
    total += best;
  }
  return total;
}

export function matchesQuery(option: InsertOption, query: string): boolean {
  return scoreOption(option, query) !== null;
}

/** Filter + rank, best first; stable for equal scores. */
export function rankOptions<T extends InsertOption>(options: T[], query: string): T[] {
  return options
    .map((option, index) => ({ option, index, score: scoreOption(option, query) }))
    .filter((entry): entry is { option: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.option);
}
