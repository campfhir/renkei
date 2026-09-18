/**
 * What a notification preference IS, and how to read one — with no database
 * anywhere in sight.
 *
 * Split from the accessors so this half stays pure: the preferences page
 * renders it in the browser, the worker consults it before writing a row,
 * and a test can exercise the precedence table without a Postgres client
 * being pulled in behind it.
 */

/** One key per preference namespace (see CONNECTORS_KEY below). Add a namespace, not a column. */
export const NOTIFICATIONS_KEY = 'notifications';

/** Where a toast appears, for someone whose eyes live in one corner. */
export type ToastCorner = 'bottom-left' | 'bottom-right';

/**
 * The categories a person can have an opinion about come from the acts
 * themselves (@renkei/tool-outcomes), re-exported here so a preferences UI
 * needs only one import. Defining them twice would eventually mean a switch
 * for a category nothing emits, or a category with no switch.
 */
export { ACT_CATEGORIES, type ActCategory } from '@renkei/tool-outcomes';

/**
 * One event, three places it can reach someone: the in-app feed (and the
 * push it triggers while Renkei is closed), an email, a WebEx message. Not
 * every event offers all three — see `PauseDelivery` below.
 */
export interface DeliveryPrefs {
  app: boolean;
  email: boolean;
  webex: boolean;
}

/**
 * An approval or a question is not really optional in the app: the run is
 * physically parked behind that card, so there is nothing to turn off —
 * only whether it ALSO reaches you by email or WebEx while it waits.
 */
export interface PauseDeliveryPrefs {
  email: boolean;
  webex: boolean;
}

/**
 * The events an AGENT can be overridden on — the same five that carry a
 * real DeliveryPrefs/PauseDeliveryPrefs shape at the general-preference
 * level. `acts` is deliberately excluded: connector × category × channel ×
 * agent is a combinatorial size no table could stay scannable at.
 */
export interface AgentNotificationOverride {
  runStarted?: DeliveryPrefs;
  runFinished?: DeliveryPrefs;
  runFailed?: DeliveryPrefs;
  agentEditedByOthers?: DeliveryPrefs;
  approvalNeeded?: PauseDeliveryPrefs;
  questionAsked?: PauseDeliveryPrefs;
}

/** The five keys `AgentNotificationOverride` and the run/edit events share. */
export type OverridableEvent = keyof AgentNotificationOverride;

export interface NotificationPrefs {
  /**
   * Off by default. An agent starting is not news — it is the most frequent
   * thing that happens and the least informative, and defaulting it on
   * would teach people to ignore the whole feed in week one.
   */
  runStarted: DeliveryPrefs;
  runFinished: DeliveryPrefs;
  runFailed: DeliveryPrefs;
  /**
   * On by default: when someone the agent was shared with saves a change
   * to it, the owner hears about it. The audit trail records the edit
   * either way — this switch only controls the notification.
   */
  agentEditedByOthers: DeliveryPrefs;
  /** A run pausing for a decision. The card is fixed on; email/WebEx are not. */
  approvalNeeded: PauseDeliveryPrefs;
  /** A run pausing for an answer. Same shape, same reasoning. */
  questionAsked: PauseDeliveryPrefs;
  /**
   * Batch jobs (a document OCR pipeline over a folder of files, and
   * whatever kinds follow). Addressed to the batch's owner — for a
   * scheduled batch, whoever owns the schedule. Same three channels as a
   * run event, the same "started is off, finished and failed are on"
   * defaults, and NOT per-agent overridable: a batch has no agent.
   */
  batchStarted: DeliveryPrefs;
  batchFinished: DeliveryPrefs;
  batchFailed: DeliveryPrefs;
  /**
   * On by default: someone shares a chat of theirs with you. Not
   * per-agent overridable — a chat has no agent.
   */
  chatShared: DeliveryPrefs;
  /** On by default: someone shares an agent of theirs with you. */
  agentShared: DeliveryPrefs;
  /**
   * Off by default. A desktop pop-up when an agent's reply lands in one of
   * your chats while this tab isn't the one in front — the in-app feed and
   * the pop-up pile already cover a tab that IS in front (see
   * `apps/web/public/sw.js`'s own focus check), so this is reach only, the
   * same role `sendPush` plays for every other event. Email and WebEx make
   * no sense for a single chat reply the way they do for a run finishing,
   * so unlike the events above this is a plain switch rather than a
   * three-channel triple.
   */
  chatReplyDesktop: boolean;
  /**
   * connector → category → delivery. Absent = the category default for
   * `app`, off for `email`/`webex`. Category, not per-act: an act-by-act
   * grid times three channels was tried (see the preferences form's own
   * history) and it does not survive contact with eleven connectors and a
   * couple hundred acts between them.
   */
  acts: Record<string, Record<string, DeliveryPrefs>>;
  /**
   * agentId → the events THIS agent overrides. Still one person's own
   * document — an override is a field the person themself chose, for a
   * moment they read as belonging to that specific agent ("page me for
   * Sunday Sweep even though I don't want that in general"), not a second,
   * disconnected preference system: it fills in from, and is read
   * alongside, everything above rather than replacing it (see
   * `effectiveDelivery`/`effectivePauseDelivery`).
   */
  agentOverrides: Record<string, AgentNotificationOverride>;
  /** Whether anything pops up in the corner; the page always fills. */
  toastsEnabled: boolean;
  toastCorner: ToastCorner;
}

/*
  Native browser notifications (the OS banner for a background tab) are
  deliberately NOT in here. `Notification.permission` is per-origin and
  per-BROWSER — granting it on a laptop says nothing about a phone, and a
  synced "on" from the database would claim a state that browser has never
  actually agreed to. That preference lives in this browser's own
  localStorage instead (apps/web/lib/desktop-notifications-storage.ts),
  scoped by tenant, next to the permission it can only ever describe
  locally.
*/

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  // App defaults match the old plain booleans; email/WebEx start off for
  // everyone until turned on, same as every other channel in this file.
  runStarted: { app: false, email: false, webex: false },
  runFinished: { app: true, email: false, webex: false },
  runFailed: { app: true, email: false, webex: false },
  agentEditedByOthers: { app: true, email: false, webex: false },
  // Off for everyone until turned on by hand — an approval or question
  // already shows in the app regardless, so this is purely "also page me".
  approvalNeeded: { email: false, webex: false },
  questionAsked: { email: false, webex: false },
  batchStarted: { app: false, email: false, webex: false },
  batchFinished: { app: true, email: false, webex: false },
  batchFailed: { app: true, email: false, webex: false },
  chatShared: { app: true, email: false, webex: false },
  agentShared: { app: true, email: false, webex: false },
  chatReplyDesktop: false,
  acts: {},
  agentOverrides: {},
  toastsEnabled: true,
  toastCorner: 'bottom-right',
};

/**
 * Whether a category is wanted, on the App channel, when nobody has said
 * otherwise. Email and WebEx have no such default — they start off for
 * every category, every connector, until someone turns one on.
 *
 * 'other' is OFF even on App: it is the uncurated majority — every act tool
 * with no declared outcome — and switching it on is one control for
 * somebody who wants everything. Defaulting it on would bury the five
 * categories that carry a real sentence under a hundred that say "ran a
 * tool".
 */
export function defaultForCategory(category: string): boolean {
  return category !== 'other';
}

/** The three channels' defaults for one category, before anyone has chosen. */
function defaultDelivery(category: string): DeliveryPrefs {
  return { app: defaultForCategory(category), email: false, webex: false };
}

/**
 * The effective app/email/webex delivery for one connector's category —
 * defaults filled in wherever the person hasn't chosen.
 */
export function deliveryForCategory(
  prefs: NotificationPrefs,
  connector: string | null,
  category: string
): DeliveryPrefs {
  const stored = connector ? prefs.acts[connector]?.[category] : undefined;
  return stored ?? defaultDelivery(category);
}

/** Does this person want to hear about this category of act, on this channel? */
export function wantsAct(
  prefs: NotificationPrefs,
  connector: string | null,
  category: string,
  channel: keyof DeliveryPrefs = 'app'
): boolean {
  return deliveryForCategory(prefs, connector, category)[channel];
}

/**
 * The delivery that actually applies to one run/edit event — the agent's
 * own override when it set one for this event, otherwise the general
 * preference. `agentId` is optional because not every caller has one yet
 * (a run whose agent was deleted mid-flight, a path with no agent context
 * at all); no id or no override both mean "just the general preference".
 */
export function effectiveDelivery(
  prefs: NotificationPrefs,
  agentId: string | null | undefined,
  key: 'runStarted' | 'runFinished' | 'runFailed' | 'agentEditedByOthers'
): DeliveryPrefs {
  const override = agentId ? prefs.agentOverrides[agentId]?.[key] : undefined;
  return override ?? prefs[key];
}

/** The three batch-job events, in the order a preferences page lists them. */
export const BATCH_EVENTS = ['batchStarted', 'batchFinished', 'batchFailed'] as const;
export type BatchEvent = (typeof BATCH_EVENTS)[number];

/**
 * Which batch event a batch's terminal status is news for. 'partial' counts
 * as finished, not failed: the batch did its job for most of its items,
 * and the failed count is in the notification either way.
 */
export function batchEventForStatus(status: string): 'batchFinished' | 'batchFailed' {
  return status === 'failed' ? 'batchFailed' : 'batchFinished';
}

/** Same idea as `effectiveDelivery`, for the two pause events. */
export function effectivePauseDelivery(
  prefs: NotificationPrefs,
  agentId: string | null | undefined,
  key: 'approvalNeeded' | 'questionAsked'
): PauseDeliveryPrefs {
  const override = agentId ? prefs.agentOverrides[agentId]?.[key] : undefined;
  return override ?? prefs[key];
}

function boolOr(current: unknown, fallback: boolean): boolean {
  return typeof current === 'boolean' ? current : fallback;
}

/**
 * One channel triple, with anything unrecognized falling back per-key.
 *
 * A bare boolean is also accepted, and treated as the App channel alone
 * (email/webex default to off, same as they would for a fresh entry):
 * `runStarted`/`runFinished`/`runFailed`/`agentEditedByOthers` and every
 * `acts[connector][category]` entry used to BE a plain boolean before this
 * shape existed, so a person's saved "off" from before that migration must
 * still read as off, not silently reset to the default the moment they
 * load this page again.
 */
function deliveryPrefs(current: unknown, fallback: DeliveryPrefs): DeliveryPrefs {
  if (typeof current === 'boolean') return { ...fallback, app: current };
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return fallback;
  const raw: Record<string, unknown> = { ...current };
  return {
    app: boolOr(raw.app, fallback.app),
    email: boolOr(raw.email, fallback.email),
    webex: boolOr(raw.webex, fallback.webex),
  };
}

function pauseDeliveryPrefs(current: unknown, fallback: PauseDeliveryPrefs): PauseDeliveryPrefs {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return fallback;
  const raw: Record<string, unknown> = { ...current };
  return {
    email: boolOr(raw.email, fallback.email),
    webex: boolOr(raw.webex, fallback.webex),
  };
}

/** connector → category → DeliveryPrefs, dropping anything malformed. */
function actsMap(current: unknown): Record<string, Record<string, DeliveryPrefs>> {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return {};
  const out: Record<string, Record<string, DeliveryPrefs>> = {};
  for (const [connector, categories] of Object.entries(current)) {
    if (typeof categories !== 'object' || categories === null || Array.isArray(categories)) {
      continue;
    }
    const inner: Record<string, DeliveryPrefs> = {};
    for (const [category, entry] of Object.entries(categories)) {
      // A boolean is the pre-migration shape (see deliveryPrefs) and a real
      // choice someone made — kept. Anything else that isn't a valid triple
      // was never a real choice, and storing one anyway would invent a
      // preference nobody set, so THAT is dropped rather than defaulted.
      const isBoolean = typeof entry === 'boolean';
      if (!isBoolean && (typeof entry !== 'object' || entry === null || Array.isArray(entry))) {
        continue;
      }
      inner[category] = deliveryPrefs(entry, defaultDelivery(category));
    }
    if (Object.keys(inner).length > 0) out[connector] = inner;
  }
  return out;
}

/** One agent's override — every key optional, dropped rather than defaulted when malformed. */
function agentOverrideOf(entry: unknown): AgentNotificationOverride | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const raw: Record<string, unknown> = { ...entry };
  const out: AgentNotificationOverride = {};
  for (const key of ['runStarted', 'runFinished', 'runFailed', 'agentEditedByOthers'] as const) {
    const value = raw[key];
    const isBoolean = typeof value === 'boolean';
    if (isBoolean || (typeof value === 'object' && value !== null && !Array.isArray(value))) {
      out[key] = deliveryPrefs(value, DEFAULT_NOTIFICATION_PREFS[key]);
    }
  }
  for (const key of ['approvalNeeded', 'questionAsked'] as const) {
    const value = raw[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = pauseDeliveryPrefs(value, DEFAULT_NOTIFICATION_PREFS[key]);
    }
  }
  // An override with nothing valid in it isn't an override at all.
  return Object.keys(out).length > 0 ? out : null;
}

/** agentId → override, dropping any agent id whose entry has nothing usable. */
function agentOverridesMap(current: unknown): Record<string, AgentNotificationOverride> {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return {};
  const out: Record<string, AgentNotificationOverride> = {};
  for (const [agentId, entry] of Object.entries(current)) {
    const parsed = agentOverrideOf(entry);
    if (parsed) out[agentId] = parsed;
  }
  return out;
}

/** Parse a stored value into the typed shape, defaults filling any gap. */
export function parseNotificationPrefs(stored: unknown): NotificationPrefs {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return DEFAULT_NOTIFICATION_PREFS;
  }
  const raw: Record<string, unknown> = { ...stored };
  const corner = raw.toastCorner === 'bottom-left' ? 'bottom-left' : 'bottom-right';
  return {
    runStarted: deliveryPrefs(raw.runStarted, DEFAULT_NOTIFICATION_PREFS.runStarted),
    runFinished: deliveryPrefs(raw.runFinished, DEFAULT_NOTIFICATION_PREFS.runFinished),
    runFailed: deliveryPrefs(raw.runFailed, DEFAULT_NOTIFICATION_PREFS.runFailed),
    agentEditedByOthers: deliveryPrefs(
      raw.agentEditedByOthers,
      DEFAULT_NOTIFICATION_PREFS.agentEditedByOthers
    ),
    approvalNeeded: pauseDeliveryPrefs(
      raw.approvalNeeded,
      DEFAULT_NOTIFICATION_PREFS.approvalNeeded
    ),
    questionAsked: pauseDeliveryPrefs(raw.questionAsked, DEFAULT_NOTIFICATION_PREFS.questionAsked),
    batchStarted: deliveryPrefs(raw.batchStarted, DEFAULT_NOTIFICATION_PREFS.batchStarted),
    batchFinished: deliveryPrefs(raw.batchFinished, DEFAULT_NOTIFICATION_PREFS.batchFinished),
    batchFailed: deliveryPrefs(raw.batchFailed, DEFAULT_NOTIFICATION_PREFS.batchFailed),
    chatShared: deliveryPrefs(raw.chatShared, DEFAULT_NOTIFICATION_PREFS.chatShared),
    agentShared: deliveryPrefs(raw.agentShared, DEFAULT_NOTIFICATION_PREFS.agentShared),
    chatReplyDesktop: boolOr(raw.chatReplyDesktop, DEFAULT_NOTIFICATION_PREFS.chatReplyDesktop),
    acts: actsMap(raw.acts),
    agentOverrides: agentOverridesMap(raw.agentOverrides),
    toastsEnabled: boolOr(raw.toastsEnabled, DEFAULT_NOTIFICATION_PREFS.toastsEnabled),
    toastCorner: corner,
  };
}

/**
 * The connectors a person has added to their own connectors page.
 *
 * A second key rather than a field on the notification preferences: they are
 * read on different pages by different code, and one growing JSON blob would
 * mean the notification worker parsing catalog choices it has no use for.
 */
export const CONNECTORS_KEY = 'connectors';

export interface ConnectorPrefs {
  /**
   * Capability keys the person chose to show on their connectors page.
   * A layout preference and nothing more: it never widens or narrows which
   * tools register — that is provisioning and org policy — so a person who
   * connected something without "adding" it keeps their tools, and the page
   * shows the card anyway (added ∪ connected).
   */
  added: string[];
}

export const DEFAULT_CONNECTOR_PREFS: ConnectorPrefs = { added: [] };

/** Survives whatever jsonb hands back; anything unrecognisable is the default. */
export function parseConnectorPrefs(stored: unknown): ConnectorPrefs {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return DEFAULT_CONNECTOR_PREFS;
  }
  const raw: Record<string, unknown> = { ...stored };
  if (!Array.isArray(raw.added)) return DEFAULT_CONNECTOR_PREFS;
  const added = [
    ...new Set(
      raw.added.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    ),
  ];
  return { added };
}

/**
 * Which look the UI renders in — a third scope, next to notifications and
 * connectors, for the same reason CONNECTORS_KEY is its own key rather than
 * a field on NotificationPrefs: read by different code (the theme script
 * that runs before first paint, rather than the notification worker), so
 * one growing JSON blob would mean that code parsing preferences it has no
 * use for.
 */
export const THEME_KEY = 'theme';

/**
 * 'auto' follows the browser's `prefers-color-scheme` and updates live if it
 * changes (a laptop's scheduled night mode, say); 'light'/'dark' pin the UI
 * regardless of the system setting.
 */
export type ThemeMode = 'auto' | 'light' | 'dark';

export interface ThemePrefs {
  mode: ThemeMode;
}

export const DEFAULT_THEME_PREFS: ThemePrefs = { mode: 'auto' };

/** Survives whatever jsonb hands back; anything unrecognisable is 'auto'. */
export function parseThemePrefs(stored: unknown): ThemePrefs {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return DEFAULT_THEME_PREFS;
  }
  const raw: Record<string, unknown> = { ...stored };
  const mode = raw.mode === 'light' || raw.mode === 'dark' ? raw.mode : 'auto';
  return { mode };
}

/**
 * How the chat sounds to this person — a fourth scope, for the same reason
 * as the others: the chat page reads it on every load and the preferences
 * page writes it, and neither has any use for the notification grid.
 *
 * Only ever consulted when the org has a voice service configured; an
 * unconfigured org stores nothing and shows nothing. The voice id is the
 * vendor's (`en-US-JennyNeural`) and is checked against the org's live
 * voice list where it is used, never here — a voice the vendor retired
 * simply falls back to the org default.
 */
export const VOICE_KEY = 'voice';

export interface VoicePrefs {
  /** A vendor voice id; null means the org's default voice. */
  voice: string | null;
  /** 1 is the voice's natural pace; kept within 0.5–2. */
  rate: number;
  /** Read every reply aloud as it arrives, without pressing anything. */
  autoPlay: boolean;
  /** The language voice mode listens for; null means the org's default. */
  locale: string | null;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  voice: null,
  rate: 1,
  autoPlay: false,
  locale: null,
};

export const MIN_VOICE_RATE = 0.5;
export const MAX_VOICE_RATE = 2;

/** A vendor voice id as stored: letters, digits, dashes and underscores only. */
function voiceIdOr(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed && /^[A-Za-z0-9_-]{1,120}$/.test(trimmed) ? trimmed : fallback;
}

/** A BCP-47 tag such as `en-US`, canonicalised; anything else is the fallback. */
function localeOr(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return fallback;
  const match = /^([A-Za-z]{2,3})[-_]([A-Za-z]{2}|\d{3})$/.exec(value.trim());
  return match ? `${match[1].toLowerCase()}-${match[2].toUpperCase()}` : fallback;
}

function rateOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_VOICE_RATE, Math.max(MIN_VOICE_RATE, Math.round(value * 100) / 100));
}

/** Survives whatever jsonb hands back; anything unrecognisable is the default. */
export function parseVoicePrefs(stored: unknown): VoicePrefs {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return DEFAULT_VOICE_PREFS;
  }
  const raw: Record<string, unknown> = { ...stored };
  return {
    voice: voiceIdOr(raw.voice, DEFAULT_VOICE_PREFS.voice),
    rate: rateOr(raw.rate, DEFAULT_VOICE_PREFS.rate),
    autoPlay: boolOr(raw.autoPlay, DEFAULT_VOICE_PREFS.autoPlay),
    locale: localeOr(raw.locale, DEFAULT_VOICE_PREFS.locale),
  };
}
