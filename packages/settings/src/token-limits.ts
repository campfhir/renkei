/**
 * Token limits per person: where a person stands against the organization's
 * weekly and monthly limits, and whether new work may start for them.
 *
 * Three things meet here. The limits are organization settings
 * (`tokenLimitWeekly`, `tokenLimitMonthly`, the weekly reset's day, time and zone,
 * `modelTokenLimits`). What a person has spent is the token ledger
 * (llm_calls), which already attributes an agent's calls to its owner — so
 * a person's limit covers their chats and their agents alike. And an
 * operator's decisions about one person are the data store's `tokenLimits`
 * domain: exempt them altogether, or grant a boost for the week or month in
 * progress.
 *
 * The limit is checked where work STARTS — a chat turn (the web app's
 * start-turn), a run (@renkei/agents' createAgentRun) — and nowhere else:
 * a turn or a run already going finishes, however far past the limit it
 * ends. So a limit is a threshold, not a hard ceiling on the ledger.
 *
 * Everything that decides is pure (`weekStart`, `monthStart`,
 * `buildTokenLimitStatus`, `tokenLimitBlock`); `getTokenLimitStatus` and
 * `checkTokenLimit` only read. A check that cannot read answers "allowed":
 * a database blip is not a reason to stop everyone's work.
 */

import { getDataStore, type ModelSpend, type TokenLimitBoostRecord } from '@renkei/db';
import { ok, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getOrgSettings, type ModelTokenLimit, type OrgSettings } from './index';
import { isTimeZone, zoneAbbreviation, zonedParts, zonedTime } from './zone-time';

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** The part of the settings the limits read. */
export interface TokenLimitPolicy {
  weekly: number;
  monthly: number;
  /** 0 Sunday … 6 Saturday. */
  weekResetDay: number;
  /** Minutes after midnight, on a clock in `timeZone`. */
  weekResetMinute: number;
  /** The IANA zone the resets are told in: the week's day and time, and the month's 1st at 00:00. */
  timeZone: string;
  models: Record<string, ModelTokenLimit>;
}

export function tokenLimitPolicy(settings: OrgSettings): TokenLimitPolicy {
  return {
    weekly: Math.max(0, Math.trunc(settings.tokenLimitWeekly)),
    monthly: Math.max(0, Math.trunc(settings.tokenLimitMonthly)),
    weekResetDay: ((Math.trunc(settings.tokenLimitWeekResetDay) % 7) + 7) % 7,
    weekResetMinute: Math.min(Math.max(0, Math.trunc(settings.tokenLimitWeekResetMinute)), 1439),
    timeZone: isTimeZone(settings.tokenLimitTimeZone) ? settings.tokenLimitTimeZone : 'UTC',
    models: settings.modelTokenLimits,
  };
}

/** Whether the policy limits anything at all; with none, nothing needs reading. */
export function policyLimitsAnything(policy: TokenLimitPolicy): boolean {
  return policy.weekly > 0 || policy.monthly > 0 || Object.keys(policy.models).length > 0;
}

/**
 * The week `now` falls in: from the latest reset at or before it to the
 * next, the reset being `resetDay` at `resetMinute` past midnight on a
 * clock in `timeZone`. The next reset is the same wall time seven days on,
 * so a week that holds a daylight-saving change is an hour off 168.
 */
export function weekBounds(
  now: Date,
  resetDay: number,
  resetMinute: number,
  timeZone = 'UTC'
): { startsAt: Date; resetsAt: Date } {
  const wall = zonedParts(now, timeZone);
  const hour = Math.floor(resetMinute / 60);
  const minute = resetMinute % 60;
  const resetOn = (day: number) => zonedTime(timeZone, wall.year, wall.month, day, hour, minute);
  let day = wall.day - ((wall.weekday - resetDay + 7) % 7);
  // The reset day is today, and its time has not come: the week began seven days ago.
  if (resetOn(day).getTime() > now.getTime()) day -= 7;
  return { startsAt: resetOn(day), resetsAt: resetOn(day + 7) };
}

/** The latest weekly reset at or before `now`. */
export function weekStart(
  now: Date,
  resetDay: number,
  resetMinute: number,
  timeZone = 'UTC'
): Date {
  return weekBounds(now, resetDay, resetMinute, timeZone).startsAt;
}

/** The 1st of `now`'s month at 00:00, on a clock in `timeZone`. */
export function monthStart(now: Date, timeZone = 'UTC'): Date {
  const wall = zonedParts(now, timeZone);
  return zonedTime(timeZone, wall.year, wall.month, 1);
}

export function nextMonthStart(now: Date, timeZone = 'UTC'): Date {
  const wall = zonedParts(now, timeZone);
  return zonedTime(timeZone, wall.year, wall.month + 1, 1);
}

export interface TokenLimitPeriods {
  week: { startsAt: Date; resetsAt: Date };
  month: { startsAt: Date; resetsAt: Date };
}

export function tokenLimitPeriods(policy: TokenLimitPolicy, now: Date): TokenLimitPeriods {
  return {
    week: weekBounds(now, policy.weekResetDay, policy.weekResetMinute, policy.timeZone),
    month: {
      startsAt: monthStart(now, policy.timeZone),
      resetsAt: nextMonthStart(now, policy.timeZone),
    },
  };
}

/** Where a person stands in one period. */
export interface PeriodProgress {
  /** The organization's limit; null when there is none for this period. */
  limit: number | null;
  /** Boost tokens granted for this period, on top of the limit. */
  boost: number;
  used: number;
  startsAt: Date;
  resetsAt: Date;
}

export interface ModelProgress {
  llmModelId: string;
  week: { limit: number | null; used: number };
  month: { limit: number | null; used: number };
}

export interface TokenLimitStatus {
  /** No limit applies to this person; the numbers are still what they used. */
  exempt: boolean;
  /** The zone the resets are told in. */
  timeZone: string;
  week: PeriodProgress;
  month: PeriodProgress;
  /** One entry per model the organization limits. */
  models: ModelProgress[];
  boosts: TokenLimitBoostRecord[];
}

export interface TokenLimitInputs {
  policy: TokenLimitPolicy;
  now: Date;
  exempt: boolean;
  /** Boosts still running at `now`. */
  boosts: readonly TokenLimitBoostRecord[];
  weekSpend: readonly ModelSpend[];
  monthSpend: readonly ModelSpend[];
}

const total = (spend: readonly ModelSpend[]) => spend.reduce((sum, row) => sum + row.tokens, 0);
const onModel = (spend: readonly ModelSpend[], llmModelId: string) =>
  spend.find((row) => row.llmModelId === llmModelId)?.tokens ?? 0;
const limitOf = (value: number) => (value > 0 ? value : null);

export function buildTokenLimitStatus(inputs: TokenLimitInputs): TokenLimitStatus {
  const { policy, now } = inputs;
  const periods = tokenLimitPeriods(policy, now);
  const running = inputs.boosts.filter((boost) => boost.expiresAt.getTime() > now.getTime());
  const boosted = (period: 'week' | 'month') =>
    running.filter((boost) => boost.period === period).reduce((sum, b) => sum + b.tokens, 0);
  return {
    exempt: inputs.exempt,
    timeZone: policy.timeZone,
    week: {
      limit: limitOf(policy.weekly),
      boost: boosted('week'),
      used: total(inputs.weekSpend),
      ...periods.week,
    },
    month: {
      limit: limitOf(policy.monthly),
      boost: boosted('month'),
      used: total(inputs.monthSpend),
      ...periods.month,
    },
    models: Object.entries(policy.models)
      .map(([llmModelId, limit]) => ({
        llmModelId,
        week: { limit: limitOf(limit.weekly), used: onModel(inputs.weekSpend, llmModelId) },
        month: { limit: limitOf(limit.monthly), used: onModel(inputs.monthSpend, llmModelId) },
      }))
      .sort((a, b) => (a.llmModelId < b.llmModelId ? -1 : a.llmModelId > b.llmModelId ? 1 : 0)),
    boosts: running,
  };
}

/** The limit that stops new work. */
export interface TokenLimitBlock {
  period: 'week' | 'month';
  /** The model whose own limit is reached; null when it is the person's overall limit. */
  llmModelId: string | null;
  /** The limit in force, boosts included. */
  limit: number;
  used: number;
  resetsAt: Date;
  /** The zone the reset is told in; UTC when left out. */
  timeZone?: string;
}

/**
 * The limit that stops new work on `llmModelId` (null: no model named, so
 * only the overall limits apply), or null when it may start. The week is
 * named before the month, and the person's overall limit before a model's:
 * the nearest reset and the widest stop are what the person needs to hear.
 */
export function tokenLimitBlock(
  status: TokenLimitStatus,
  llmModelId: string | null
): TokenLimitBlock | null {
  if (status.exempt) return null;
  for (const period of ['week', 'month'] as const) {
    const progress = status[period];
    if (progress.limit !== null && progress.used >= progress.limit + progress.boost) {
      return {
        period,
        llmModelId: null,
        limit: progress.limit + progress.boost,
        used: progress.used,
        resetsAt: progress.resetsAt,
        timeZone: status.timeZone,
      };
    }
  }
  const model =
    llmModelId === null ? undefined : status.models.find((m) => m.llmModelId === llmModelId);
  if (!model) return null;
  for (const period of ['week', 'month'] as const) {
    const progress = model[period];
    if (progress.limit !== null && progress.used >= progress.limit) {
      return {
        period,
        llmModelId: model.llmModelId,
        limit: progress.limit,
        used: progress.used,
        resetsAt: status[period].resetsAt,
        timeZone: status.timeZone,
      };
    }
  }
  return null;
}

/** 1,234,567 → "1.2M"; exact below a thousand. */
export function formatTokenCount(tokens: number): string {
  const short = (value: number, unit: string) =>
    `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
  if (tokens >= 1_000_000_000) return short(tokens / 1_000_000_000, 'B');
  if (tokens >= 1_000_000) return short(tokens / 1_000_000, 'M');
  if (tokens >= 1_000) return short(tokens / 1_000, 'K');
  return String(tokens);
}

/** "Monday 16 November at 00:00 UTC", on a clock in `timeZone` and naming it ("… at 09:00 EST"). */
export function formatResetAt(at: Date, timeZone = 'UTC'): string {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const two = (value: number) => String(value).padStart(2, '0');
  const wall = zonedParts(at, timeZone);
  return `${WEEKDAY_NAMES[wall.weekday]} ${wall.day} ${months[wall.month - 1]} at ${two(
    wall.hour
  )}:${two(wall.minute)} ${zoneAbbreviation(at, timeZone)}`;
}

/**
 * The sentence a refused start shows. `whose` is "You have" for the person
 * themselves, or a name ("Ada Lovelace has") when someone else's agent was
 * asked to run.
 */
export function tokenLimitMessage(
  block: TokenLimitBlock,
  options: { modelLabel?: string | null; whose?: string } = {}
): string {
  const whose = options.whose ?? 'You have';
  const period = block.period === 'week' ? 'weekly' : 'monthly';
  const used = `${formatTokenCount(block.used)} of ${formatTokenCount(block.limit)}`;
  const reset = `It resets ${formatResetAt(block.resetsAt, block.timeZone)}.`;
  if (block.llmModelId !== null) {
    const model = options.modelLabel ? `the model ${options.modelLabel}` : 'this model';
    return `${whose} reached the ${period} token limit for ${model} (${used}). ${reset} Another model can still be used.`;
  }
  return `${whose} reached the ${period} token limit (${used}). ${reset} An operator can grant a boost.`;
}

async function readPolicy(): Promise<Result<TokenLimitPolicy, 'DB_ERROR'>> {
  const settings = await getOrgSettings();
  if (!settings.ok) return settings;
  return ok(tokenLimitPolicy(settings.val));
}

/** Where `subject` stands right now: the page's read, and the check's. */
export async function getTokenLimitStatus(
  subject: string,
  now: Date = new Date()
): Promise<Result<TokenLimitStatus, 'DB_ERROR'>> {
  const policy = await readPolicy();
  if (!policy.ok) return policy;
  const periods = tokenLimitPeriods(policy.val, now);
  const store = getDataStore().tokenLimits;
  const read = await wrapAsync(
    () =>
      Promise.all([
        store.isExempt(subject),
        store.activeBoosts(now, subject),
        store.spentSince(subject, periods.week.startsAt),
        store.spentSince(subject, periods.month.startsAt),
      ]),
    'DB_ERROR' as const
  );
  if (!read.ok) return read;
  const [exempt, boosts, weekSpend, monthSpend] = read.val;
  return ok(
    buildTokenLimitStatus({ policy: policy.val, now, exempt, boosts, weekSpend, monthSpend })
  );
}

/**
 * Whether new work may start for `subject` on `llmModelId` — null for "the
 * organization's default model", which is looked up only when some model
 * carries a limit of its own. Answers the block, or null to go ahead; a
 * read that fails goes ahead.
 */
export async function checkTokenLimit(
  subject: string,
  llmModelId: string | null,
  now: Date = new Date()
): Promise<TokenLimitBlock | null> {
  const policy = await readPolicy();
  if (!policy.ok || !policyLimitsAnything(policy.val)) return null;
  const status = await getTokenLimitStatus(subject, now);
  if (!status.ok) return null;
  let modelId = llmModelId;
  if (modelId === null && status.val.models.length > 0) {
    const fallback = await wrapAsync(
      () => getDataStore().llmModels.findEnabledChatModel(null),
      'DB_ERROR' as const
    );
    modelId = fallback.ok ? (fallback.val?.id ?? null) : null;
  }
  return tokenLimitBlock(status.val, modelId);
}
