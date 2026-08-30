/**
 * What a notification preference IS, and how to read one — with no database
 * anywhere in sight.
 *
 * Split from the accessors so this half stays pure: the preferences page
 * renders it in the browser, the worker consults it before writing a row,
 * and a test can exercise the precedence table without a Postgres client
 * being pulled in behind it.
 */

/** The one preference key so far. Add a namespace, not a column. */
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

export interface NotificationPrefs {
  /**
   * Off by default. An agent starting is not news — it is the most frequent
   * thing that happens and the least informative, and defaulting it on
   * would teach people to ignore the whole feed in week one.
   */
  runStarted: boolean;
  runFinished: boolean;
  runFailed: boolean;
  /**
   * On by default: when someone the agent was shared with saves a change
   * to it, the owner hears about it. The audit trail records the edit
   * either way — this switch only controls the notification.
   */
  agentEditedByOthers: boolean;
  /** connector key → category → wanted. Absent = the default for it. */
  acts: Record<string, Record<string, boolean>>;
  /** Tool name → wanted. Overrides `acts` in EITHER direction. */
  tools: Record<string, boolean>;
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
  runStarted: false,
  runFinished: true,
  runFailed: true,
  agentEditedByOthers: true,
  acts: {},
  tools: {},
  toastsEnabled: true,
  toastCorner: 'bottom-right',
};

/**
 * Whether a category is wanted when nobody has said otherwise.
 *
 * 'other' is OFF: it is the uncurated majority — every act tool with no
 * declared outcome — and switching it on is one control for somebody who
 * wants everything. Defaulting it on would bury the five categories that
 * carry a real sentence under a hundred that say "ran a tool".
 */
export function defaultForCategory(category: string): boolean {
  return category !== 'other';
}

/**
 * Does this person want to hear about this act?
 *
 * Precedence, most specific first: an explicit per-tool switch, then the
 * connector×category grid, then the category default. Each layer only
 * applies where it was actually set, so a grid entry does not silently
 * override the tool switch someone set deliberately.
 */
export function wantsAct(
  prefs: NotificationPrefs,
  connector: string | null,
  category: string,
  tool: string | null
): boolean {
  if (tool && tool in prefs.tools) return prefs.tools[tool] === true;
  const forConnector = connector ? prefs.acts[connector] : undefined;
  if (forConnector && category in forConnector) return forConnector[category] === true;
  return defaultForCategory(category);
}

function boolOr(current: unknown, fallback: boolean): boolean {
  return typeof current === 'boolean' ? current : fallback;
}

/** A record of booleans, with anything else dropped rather than trusted. */
function boolMap(current: unknown): Record<string, boolean> {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(current)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/** A record of records of booleans — the connector×category grid. */
function nestedBoolMap(current: unknown): Record<string, Record<string, boolean>> {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return {};
  const out: Record<string, Record<string, boolean>> = {};
  for (const [key, value] of Object.entries(current)) {
    const inner = boolMap(value);
    if (Object.keys(inner).length > 0) out[key] = inner;
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
    runStarted: boolOr(raw.runStarted, DEFAULT_NOTIFICATION_PREFS.runStarted),
    runFinished: boolOr(raw.runFinished, DEFAULT_NOTIFICATION_PREFS.runFinished),
    runFailed: boolOr(raw.runFailed, DEFAULT_NOTIFICATION_PREFS.runFailed),
    agentEditedByOthers: boolOr(
      raw.agentEditedByOthers,
      DEFAULT_NOTIFICATION_PREFS.agentEditedByOthers
    ),
    acts: nestedBoolMap(raw.acts),
    tools: boolMap(raw.tools),
    toastsEnabled: boolOr(raw.toastsEnabled, DEFAULT_NOTIFICATION_PREFS.toastsEnabled),
    toastCorner: corner,
  };
}
