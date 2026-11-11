/**
 * The Token limits page's state (token-limits-form.tsx): the organization's
 * limits as edited and as stored, the people list and its filter, and the
 * one boost form that may be open.
 *
 * The component makes the calls and renders; what the page decides — what
 * a typed amount means, whether Save is allowed, what the request carries
 * (only what changed, a model's limit patched or removed by itself), what a
 * refusal leaves on screen, who the filter shows, when a boost may be
 * granted and what the grant sends — is here, and tested in
 * token-limits.model.test.ts. The server clamps and refuses on its own
 * (app/api/admin/token-limits).
 */

import { parseTokens, tokensFieldText } from '@/lib/token-limits/format';

export interface ModelLimit {
  weekly: number;
  monthly: number;
}

export interface Policy {
  weekly: number;
  monthly: number;
  /** 0 Sunday … 6 Saturday. */
  weekResetDay: number;
  /** Minutes after midnight, on a clock in `timeZone`. */
  weekResetMinute: number;
  /** The IANA zone the resets are told in. */
  timeZone: string;
  models: Record<string, ModelLimit>;
}

export interface Boost {
  id: string;
  period: 'week' | 'month';
  tokens: number;
  expiresAt: string;
  note: string | null;
}

export interface Person {
  subject: string;
  name: string;
  email: string;
  exempt: boolean;
  weekUsed: number;
  monthUsed: number;
  boosts: Boost[];
}

export interface Model {
  id: string;
  label: string;
  enabled: boolean;
}

/** What the server answers, on load and after every change. */
export interface TokenLimitsView {
  policy: Policy;
  weekResetsAt: string;
  monthResetsAt: string;
  models: Model[];
  people: Person[];
}

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** The limits as typed: amounts are text until Save reads them. */
export interface Draft {
  weekly: string;
  monthly: string;
  weekResetDay: number;
  /** "HH:MM", on a clock in `timeZone`. */
  weekResetTime: string;
  timeZone: string;
  models: Record<string, { weekly: string; monthly: string }>;
}

export interface BoostDraft {
  subject: string;
  period: 'week' | 'month';
  tokens: string;
  note: string;
}

export type SavePhase = 'idle' | 'saving' | 'saved' | 'error';

export interface TokenLimitsState {
  view: TokenLimitsView;
  draft: Draft;
  phase: SavePhase;
  error: string | null;
  filter: string;
  boost: BoostDraft | null;
  /** The person or boost a request is in flight for. */
  busy: string | null;
  /** Why the last change to a person was refused. */
  personError: string | null;
}

export type TokenLimitsAction =
  | { type: 'limitsChanged'; patch: Partial<Omit<Draft, 'models'>> }
  | { type: 'modelChanged'; modelId: string; patch: Partial<{ weekly: string; monthly: string }> }
  | { type: 'saveSent' }
  /** The limits were stored; the answer is everything the page shows. */
  | { type: 'saved'; view: TokenLimitsView }
  | { type: 'saveFailed'; error: string | null }
  | { type: 'filterChanged'; filter: string }
  | { type: 'boostOpened'; subject: string }
  | { type: 'boostChanged'; patch: Partial<Omit<BoostDraft, 'subject'>> }
  | { type: 'boostClosed' }
  /** A change to one person (exempt, grant, take back) was sent. */
  | { type: 'personSent'; key: string }
  | { type: 'personStored'; view: TokenLimitsView }
  | { type: 'personFailed'; error: string | null };

/**
 * The zones the picker offers: the stored one first when the browser's own
 * list lacks it (so it is never silently replaced), then UTC, then the
 * browser's list.
 */
export function timeZoneOptions(stored: string, supported: readonly string[]): string[] {
  return [...new Set([...(supported.includes(stored) ? [] : [stored]), 'UTC', ...supported])];
}

export function minuteToTime(minute: number): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(Math.floor(minute / 60))}:${two(minute % 60)}`;
}

/** "17:30" → 1050; null when it is not a time of day. */
export function timeToMinute(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function draftOf(view: TokenLimitsView): Draft {
  const models: Draft['models'] = {};
  for (const model of view.models) {
    const limit = view.policy.models[model.id];
    models[model.id] = {
      weekly: tokensFieldText(limit?.weekly ?? 0),
      monthly: tokensFieldText(limit?.monthly ?? 0),
    };
  }
  return {
    weekly: tokensFieldText(view.policy.weekly),
    monthly: tokensFieldText(view.policy.monthly),
    weekResetDay: view.policy.weekResetDay,
    weekResetTime: minuteToTime(view.policy.weekResetMinute),
    timeZone: view.policy.timeZone,
    models,
  };
}

export function initTokenLimits(view: TokenLimitsView): TokenLimitsState {
  return {
    view,
    draft: draftOf(view),
    phase: 'idle',
    error: null,
    filter: '',
    boost: null,
    busy: null,
    personError: null,
  };
}

export function tokenLimitsReducer(
  state: TokenLimitsState,
  action: TokenLimitsAction
): TokenLimitsState {
  switch (action.type) {
    case 'limitsChanged':
      // An edit after a save takes the "Saved." away; a shown error stays
      // until the next save is sent.
      return { ...state, draft: { ...state.draft, ...action.patch }, phase: 'idle' };
    case 'modelChanged': {
      const current = state.draft.models[action.modelId] ?? { weekly: '', monthly: '' };
      return {
        ...state,
        draft: {
          ...state.draft,
          models: { ...state.draft.models, [action.modelId]: { ...current, ...action.patch } },
        },
        phase: 'idle',
      };
    }
    case 'saveSent':
      return { ...state, phase: 'saving', error: null };
    case 'saved':
      // The server clamps; the fields take what it stored.
      return {
        ...state,
        view: action.view,
        draft: draftOf(action.view),
        phase: 'saved',
        error: null,
      };
    case 'saveFailed':
      return { ...state, phase: 'error', error: action.error ?? 'Save failed' };
    case 'filterChanged':
      return { ...state, filter: action.filter };
    case 'boostOpened':
      return {
        ...state,
        boost: { subject: action.subject, period: 'week', tokens: '', note: '' },
        personError: null,
      };
    case 'boostChanged':
      return state.boost ? { ...state, boost: { ...state.boost, ...action.patch } } : state;
    case 'boostClosed':
      return { ...state, boost: null };
    case 'personSent':
      return { ...state, busy: action.key, personError: null };
    case 'personStored':
      // People change under an unsaved limits edit: the typing is kept, and
      // only the stored side moves. A granted boost closes its form.
      return { ...state, view: action.view, busy: null, boost: null, personError: null };
    case 'personFailed':
      // The form stays open with what was typed, beside the reason.
      return { ...state, busy: null, personError: action.error ?? 'That did not go through' };
  }
}

/** The draft as numbers, or null while any field is not an amount or a time. */
export function draftPolicy(state: TokenLimitsState): Policy | null {
  const weekly = parseTokens(state.draft.weekly);
  const monthly = parseTokens(state.draft.monthly);
  const weekResetMinute = timeToMinute(state.draft.weekResetTime);
  if (weekly === null || monthly === null || weekResetMinute === null) return null;
  const models: Record<string, ModelLimit> = {};
  for (const [modelId, typed] of Object.entries(state.draft.models)) {
    const modelWeekly = parseTokens(typed.weekly);
    const modelMonthly = parseTokens(typed.monthly);
    if (modelWeekly === null || modelMonthly === null) return null;
    if (modelWeekly > 0 || modelMonthly > 0) {
      models[modelId] = { weekly: modelWeekly, monthly: modelMonthly };
    }
  }
  return {
    weekly,
    monthly,
    weekResetDay: state.draft.weekResetDay,
    weekResetMinute,
    timeZone: state.draft.timeZone,
    models,
  };
}

/** Whether a typed amount is one; the field is marked when it is not. */
export function isAmount(text: string): boolean {
  return parseTokens(text) !== null;
}

export interface SaveRequest {
  weekly?: number;
  monthly?: number;
  weekResetDay?: number;
  weekResetMinute?: number;
  timeZone?: string;
  /** Only the models whose limit changed; null takes a model's limit away. */
  models?: Record<string, ModelLimit | null>;
}

/**
 * What Save sends: only what this form changed. The limits are the whole
 * organization's, and sending every field would write another operator's
 * concurrent save back to what this page last loaded.
 */
export function saveRequest(state: TokenLimitsState): SaveRequest | null {
  const next = draftPolicy(state);
  if (!next) return null;
  const stored = state.view.policy;
  const request: SaveRequest = {};
  if (next.weekly !== stored.weekly) request.weekly = next.weekly;
  if (next.monthly !== stored.monthly) request.monthly = next.monthly;
  if (next.weekResetDay !== stored.weekResetDay) request.weekResetDay = next.weekResetDay;
  if (next.weekResetMinute !== stored.weekResetMinute) {
    request.weekResetMinute = next.weekResetMinute;
  }
  if (next.timeZone !== stored.timeZone) request.timeZone = next.timeZone;
  const models: Record<string, ModelLimit | null> = {};
  for (const modelId of new Set([...Object.keys(stored.models), ...Object.keys(next.models)])) {
    const before = stored.models[modelId];
    const after = next.models[modelId];
    // A stored limit for a model the roster no longer lists is not this form's to touch.
    if (!after && !(modelId in state.draft.models)) continue;
    if (before?.weekly === after?.weekly && before?.monthly === after?.monthly) continue;
    models[modelId] = after ?? null;
  }
  if (Object.keys(models).length > 0) request.models = models;
  return request;
}

export function isDirty(state: TokenLimitsState): boolean {
  const request = saveRequest(state);
  return request === null || Object.keys(request).length > 0;
}

/** Save is on when something changed, every field reads, and no save is in flight. */
export function canSave(state: TokenLimitsState): boolean {
  const request = saveRequest(state);
  return state.phase !== 'saving' && request !== null && Object.keys(request).length > 0;
}

/** Whether the organization limits anyone at all, as stored. */
export function limitsAnything(policy: Policy): boolean {
  return policy.weekly > 0 || policy.monthly > 0 || Object.keys(policy.models).length > 0;
}

/** The people the filter shows: name, email or subject contains what was typed. */
export function visiblePeople(state: TokenLimitsState): Person[] {
  const needle = state.filter.trim().toLowerCase();
  if (!needle) return state.view.people;
  return state.view.people.filter((person) =>
    [person.name, person.email, person.subject].some((text) => text.toLowerCase().includes(needle))
  );
}

/** A person's boost tokens for one period. */
export function boostTotal(person: Person, period: 'week' | 'month'): number {
  return person.boosts
    .filter((boost) => boost.period === period)
    .reduce((sum, boost) => sum + boost.tokens, 0);
}

/** What Grant sends, or null while the amount is not above zero. */
export function boostRequest(
  state: TokenLimitsState
): { subject: string; period: 'week' | 'month'; tokens: number; note?: string } | null {
  if (!state.boost) return null;
  const tokens = parseTokens(state.boost.tokens);
  if (tokens === null || tokens < 1) return null;
  const note = state.boost.note.trim();
  return {
    subject: state.boost.subject,
    period: state.boost.period,
    tokens,
    ...(note ? { note } : {}),
  };
}

export function canGrant(state: TokenLimitsState): boolean {
  return state.busy === null && boostRequest(state) !== null;
}

/**
 * Whether a boost would do anything: it adds to the organization's limit
 * for its period, so with no such limit there is nothing to add to.
 */
export function boostHasEffect(policy: Policy, period: 'week' | 'month'): boolean {
  return (period === 'week' ? policy.weekly : policy.monthly) > 0;
}
