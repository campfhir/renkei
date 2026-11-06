/**
 * The notification preferences form's state (preferences-form.tsx): the
 * preferences being edited, the preferences as last saved, each card's own
 * Save (a card saves only its own fields), the per-agent override picker,
 * and this browser's desktop-notification switch.
 *
 * Also the rows the server page lays out (`notificationConnectorRows`):
 * which categories each connector's acts are offered under. Everything
 * the form decides — what a switch changes and what it leaves alone,
 * what an override starts from, what Save sends, what a box shows when
 * its channel is not connected, where the desktop switch lands after the
 * browser answers — is here, and tested in preferences-form.model.test.ts.
 */

import {
  deliveryForCategory,
  type AgentNotificationOverride,
  type BatchEvent,
  type DeliveryPrefs,
  type NotificationPrefs,
  type OverridableEvent,
  type PauseDeliveryPrefs,
  type ToastCorner,
} from '@renkei/user-prefs/prefs';

/** One connector's row: the categories its acts fall into. */
export interface ConnectorRow {
  key: string;
  label: string;
  categories: string[];
}

export interface ChannelAvailability {
  outlook: boolean;
  webex: boolean;
}

/** The browser's answer to "may Renkei notify?"; null before it is read. */
export type DesktopPermission = 'default' | 'granted' | 'denied' | 'unsupported' | null;

/** What turning the desktop switch on came back with (lib/push-subscription.ts). */
export type EnableOutcome = 'granted' | 'denied' | 'unsupported' | 'subscribe-failed';

export type DeliveryEvent =
  | 'runStarted'
  | 'runFinished'
  | 'runFailed'
  | 'agentEditedByOthers'
  | BatchEvent
  | 'chatShared'
  | 'agentShared';

export type RunEvent = 'runStarted' | 'runFinished' | 'runFailed' | 'agentEditedByOthers';
export type PauseEvent = 'approvalNeeded' | 'questionAsked';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

/** The cards on the form, each with a Save of its own. */
export type NotificationGroup =
  'runs' | 'batch' | 'sharing' | 'pauses' | 'overrides' | 'acts' | 'popups' | 'browser';

/**
 * The fields each card edits and saves; every field of NotificationPrefs
 * belongs to exactly one (preferences-form.model.test.ts checks). The
 * desktop switch is not here: it is this browser's own, applied at once.
 */
export const GROUP_FIELDS: Record<NotificationGroup, readonly (keyof NotificationPrefs)[]> = {
  runs: ['runStarted', 'runFinished', 'runFailed', 'agentEditedByOthers'],
  batch: ['batchStarted', 'batchFinished', 'batchFailed'],
  sharing: ['chatShared', 'agentShared'],
  pauses: ['approvalNeeded', 'questionAsked'],
  overrides: ['agentOverrides'],
  acts: ['acts'],
  popups: ['toastsEnabled', 'toastCorner'],
  browser: ['chatReplyDesktop', 'openInSourceApp'],
};

/** The cards, in the order the form shows them. */
export const NOTIFICATION_GROUPS: readonly NotificationGroup[] = [
  'runs',
  'batch',
  'sharing',
  'pauses',
  'overrides',
  'acts',
  'popups',
  'browser',
];

export interface PreferencesState {
  /** As on screen. */
  prefs: NotificationPrefs;
  /** As the server last confirmed: what a card's unsaved changes are measured from. */
  saved: NotificationPrefs;
  /** Each card's Save: idle, out, saved (until its next change), or refused. */
  groups: Record<NotificationGroup, SaveStatus>;
  /** The agent whose overrides the table shows; '' with no agents. */
  overrideAgentId: string;
  desktop: {
    /** This browser's own opt-in (its localStorage), not the synced prefs. */
    enabled: boolean;
    permission: DesktopPermission;
    /** The browser said yes but telling the server about this device failed. */
    subscribeError: boolean;
  };
}

export type PreferencesAction =
  | {
      type: 'categoryChannel';
      connector: string;
      category: string;
      channel: keyof DeliveryPrefs;
      on: boolean;
    }
  | { type: 'wholeConnector'; row: ConnectorRow; channel: keyof DeliveryPrefs; on: boolean }
  | { type: 'pauseChannel'; event: PauseEvent; channel: keyof PauseDeliveryPrefs; on: boolean }
  | { type: 'deliveryChannel'; event: DeliveryEvent; channel: keyof DeliveryPrefs; on: boolean }
  | { type: 'overrideToggled'; agentId: string; event: OverridableEvent; on: boolean }
  | {
      type: 'overrideChannel';
      agentId: string;
      event: RunEvent;
      channel: keyof DeliveryPrefs;
      on: boolean;
    }
  | {
      type: 'overridePauseChannel';
      agentId: string;
      event: PauseEvent;
      channel: keyof PauseDeliveryPrefs;
      on: boolean;
    }
  | { type: 'toastsEnabled'; on: boolean }
  | { type: 'toastCorner'; corner: ToastCorner }
  | { type: 'chatReplyDesktop'; on: boolean }
  | { type: 'openInSourceApp'; on: boolean }
  | { type: 'overrideAgentPicked'; agentId: string }
  | { type: 'saveSent'; group: NotificationGroup }
  /** `sent` is the patch that card's save sent (groupSaveRequest). */
  | { type: 'saved'; group: NotificationGroup; sent: Partial<NotificationPrefs> }
  | { type: 'saveFailed'; group: NotificationGroup }
  /** The browser's state, read once it is mounted. */
  | { type: 'desktopRead'; enabled: boolean; permission: DesktopPermission }
  | { type: 'desktopOff' }
  | { type: 'desktopEnableAnswered'; outcome: EnableOutcome }
  /** "Allow notifications": the browser's fresh answer. */
  | { type: 'permissionAnswered'; permission: DesktopPermission }
  /** The device's push subscription, re-checked after a granted permission. */
  | { type: 'subscriptionChecked'; ok: boolean };

export function initPreferences(input: {
  initial: NotificationPrefs;
  agents: { id: string }[];
}): PreferencesState {
  return {
    prefs: input.initial,
    saved: input.initial,
    groups: idleGroups(),
    overrideAgentId: input.agents[0]?.id ?? '',
    desktop: { enabled: false, permission: null, subscribeError: false },
  };
}

function idleGroups(): Record<NotificationGroup, SaveStatus> {
  return {
    runs: 'idle',
    batch: 'idle',
    sharing: 'idle',
    pauses: 'idle',
    overrides: 'idle',
    acts: 'idle',
    popups: 'idle',
    browser: 'idle',
  };
}

function setAgentOverride<K extends OverridableEvent>(
  prefs: NotificationPrefs,
  agentId: string,
  event: K,
  next: AgentNotificationOverride[K]
): NotificationPrefs {
  const forAgent: AgentNotificationOverride = { ...prefs.agentOverrides[agentId], [event]: next };
  return { ...prefs, agentOverrides: { ...prefs.agentOverrides, [agentId]: forAgent } };
}

/** Turning an override off reverts the agent to the general preference; no empty entry is kept. */
function clearAgentOverride(
  prefs: NotificationPrefs,
  agentId: string,
  event: OverridableEvent
): NotificationPrefs {
  const forAgent = { ...prefs.agentOverrides[agentId] };
  delete forAgent[event];
  const agentOverrides = { ...prefs.agentOverrides };
  if (Object.keys(forAgent).length > 0) agentOverrides[agentId] = forAgent;
  else delete agentOverrides[agentId];
  return { ...prefs, agentOverrides };
}

/** The prefs a switch leaves; null for an action that is not a switch. */
function changedPrefs(
  prefs: NotificationPrefs,
  action: PreferencesAction
): NotificationPrefs | null {
  switch (action.type) {
    case 'categoryChannel': {
      // An explicit choice is stored whole, even when it matches the default.
      const current = deliveryForCategory(prefs, action.connector, action.category);
      const forConnector = {
        ...(prefs.acts[action.connector] ?? {}),
        [action.category]: { ...current, [action.channel]: action.on },
      };
      return { ...prefs, acts: { ...prefs.acts, [action.connector]: forConnector } };
    }
    case 'wholeConnector': {
      const { row } = action;
      const forConnector = { ...(prefs.acts[row.key] ?? {}) };
      for (const category of row.categories) {
        const current = deliveryForCategory(prefs, row.key, category);
        forConnector[category] = { ...current, [action.channel]: action.on };
      }
      return { ...prefs, acts: { ...prefs.acts, [row.key]: forConnector } };
    }
    case 'pauseChannel':
      return { ...prefs, [action.event]: { ...prefs[action.event], [action.channel]: action.on } };
    case 'deliveryChannel':
      return { ...prefs, [action.event]: { ...prefs[action.event], [action.channel]: action.on } };
    case 'overrideToggled':
      // An override starts as a copy of the general preference.
      return action.on
        ? setAgentOverride(prefs, action.agentId, action.event, { ...prefs[action.event] })
        : clearAgentOverride(prefs, action.agentId, action.event);
    case 'overrideChannel': {
      const current = prefs.agentOverrides[action.agentId]?.[action.event];
      if (!current) return prefs;
      return setAgentOverride(prefs, action.agentId, action.event, {
        ...current,
        [action.channel]: action.on,
      });
    }
    case 'overridePauseChannel': {
      const current = prefs.agentOverrides[action.agentId]?.[action.event];
      if (!current) return prefs;
      return setAgentOverride(prefs, action.agentId, action.event, {
        ...current,
        [action.channel]: action.on,
      });
    }
    case 'toastsEnabled':
      return { ...prefs, toastsEnabled: action.on };
    case 'toastCorner':
      return { ...prefs, toastCorner: action.corner };
    case 'chatReplyDesktop':
      return { ...prefs, chatReplyDesktop: action.on };
    case 'openInSourceApp':
      return { ...prefs, openInSourceApp: action.on };
    default:
      return null;
  }
}

export function preferencesReducer(
  state: PreferencesState,
  action: PreferencesAction
): PreferencesState {
  const prefs = changedPrefs(state.prefs, action);
  if (prefs) {
    // A change takes its own card's "Saved." away (it no longer describes
    // what is on screen), and leaves every other card's alone.
    const groups = { ...state.groups };
    for (const group of NOTIFICATION_GROUPS) {
      const touched = GROUP_FIELDS[group].some((field) => prefs[field] !== state.prefs[field]);
      if (touched && groups[group] !== 'saving') groups[group] = 'idle';
    }
    return { ...state, prefs, groups };
  }
  switch (action.type) {
    case 'overrideAgentPicked':
      return { ...state, overrideAgentId: action.agentId };
    case 'saveSent':
      return { ...state, groups: { ...state.groups, [action.group]: 'saving' } };
    case 'saved':
      return {
        ...state,
        saved: { ...state.saved, ...action.sent },
        groups: { ...state.groups, [action.group]: 'saved' },
      };
    case 'saveFailed':
      return { ...state, groups: { ...state.groups, [action.group]: 'failed' } };
    case 'desktopRead':
      return {
        ...state,
        desktop: { ...state.desktop, enabled: action.enabled, permission: action.permission },
      };
    case 'desktopOff':
      return { ...state, desktop: { ...state.desktop, enabled: false, subscribeError: false } };
    case 'desktopEnableAnswered': {
      // The switch stays off unless the browser said yes AND the server
      // heard about this device: "on" for something that can never fire
      // would look exactly like a bug.
      const { outcome } = action;
      return {
        ...state,
        desktop: {
          enabled: outcome === 'granted',
          permission:
            outcome === 'unsupported' ? 'unsupported' : outcome === 'denied' ? 'denied' : 'granted',
          subscribeError: outcome === 'subscribe-failed',
        },
      };
    }
    case 'permissionAnswered':
      return { ...state, desktop: { ...state.desktop, permission: action.permission } };
    case 'subscriptionChecked':
      return { ...state, desktop: { ...state.desktop, subscribeError: !action.ok } };
    default:
      return state;
  }
}

/** Whether a card's fields on screen differ from what was last saved. */
export function groupDirty(state: PreferencesState, group: NotificationGroup): boolean {
  return GROUP_FIELDS[group].some(
    (field) => JSON.stringify(state.prefs[field]) !== JSON.stringify(state.saved[field])
  );
}

/**
 * Whether a card's Save can be pressed: it has changes and is not already
 * saving. Other cards saving at the same time are no obstacle: each sends
 * a patch of its own fields, which the server merges atomically.
 */
export function canSaveGroup(state: PreferencesState, group: NotificationGroup): boolean {
  return groupDirty(state, group) && state.groups[group] !== 'saving';
}

/**
 * What a card's Save shows: nothing while it has nothing to save and
 * nothing to report, so an untouched card carries no button.
 */
export function groupSaveView(
  state: PreferencesState,
  group: NotificationGroup
): { show: boolean; label: string; message: 'saved' | 'failed' | null } {
  const status = state.groups[group];
  return {
    show: status !== 'idle' || groupDirty(state, group),
    label: status === 'saving' ? 'Saving…' : 'Save',
    message: status === 'saved' ? 'saved' : status === 'failed' ? 'failed' : null,
  };
}

/**
 * What a card's Save PATCHes to /api/preferences: this card's fields as on
 * screen, and nothing else — another card's unsaved changes stay unsaved,
 * and sending it twice changes nothing the first did not.
 */
export function groupSaveRequest(
  state: PreferencesState,
  group: NotificationGroup
): { notifications: Partial<NotificationPrefs> } {
  const notifications: Partial<NotificationPrefs> = {};
  for (const field of GROUP_FIELDS[group]) {
    Object.assign(notifications, { [field]: state.prefs[field] });
  }
  return { notifications };
}

/**
 * The words a desktop permission earns under the switch, and whether the
 * "Allow notifications" re-ask shows: only when the switch reads on but the
 * browser has drifted back to asking.
 */
export function desktopView(state: PreferencesState): {
  switchDisabled: boolean;
  showAllow: boolean;
  chatReplyDisabled: boolean;
} {
  const { enabled, permission } = state.desktop;
  return {
    switchDisabled: permission === 'unsupported',
    showAllow: enabled && permission === 'default',
    chatReplyDisabled: !enabled,
  };
}

/** A box for a channel that is not connected reads off, whatever is stored. */
export function channelBox(
  stored: boolean,
  connected: boolean
): { checked: boolean; disabled: boolean } {
  return { checked: connected && stored, disabled: !connected };
}

/** An agent's override row: what it shows, and whether its channels can change. */
export function overrideRow<K extends RunEvent | PauseEvent>(
  prefs: NotificationPrefs,
  agentId: string,
  event: K
): {
  overridden: boolean;
  effective: NonNullable<AgentNotificationOverride[K]> | NotificationPrefs[K];
} {
  const override = prefs.agentOverrides[agentId]?.[event];
  return { overridden: override !== undefined, effective: override ?? prefs[event] };
}

/** A collapsed connector's summary: "3 of 6 in the app", plus Outlook/WebEx when any is on. */
export function connectorSummary(
  prefs: NotificationPrefs,
  row: ConnectorRow
): { appOn: number; total: number; anyExtraChannel: boolean } {
  const deliveries = row.categories.map((category) =>
    deliveryForCategory(prefs, row.key, category)
  );
  return {
    appOn: deliveries.filter((delivery) => delivery.app).length,
    total: row.categories.length,
    anyExtraChannel: deliveries.some((delivery) => delivery.email || delivery.webex),
  };
}

const CATEGORY_LABEL: Record<string, string> = {
  created: 'Creates something',
  sent: 'Sends something',
  updated: 'Updates something',
  deleted: 'Deletes something',
  scheduled: 'Schedules something',
  other: 'Anything else',
};

const CATEGORY_HINT: Record<string, string> = {
  other: 'No specific wording yet — off to start with, like today.',
};

/** What a category's row is called, and the hint under it. */
export function categoryLabel(category: string): { label: string; hint: string | null } {
  return { label: CATEGORY_LABEL[category] ?? category, hint: CATEGORY_HINT[category] ?? null };
}

/**
 * The connectors the form lists, each with the categories its acts fall
 * into. One row per capability key (Jira and Jira Service Management share
 * one, and two rows would be two switches for one thing); 'other' is
 * always offered, as the catch-all; a connector with no curated acts is
 * left out — there is nothing to decide yet. Categories in `order`.
 */
export function notificationConnectorRows(
  catalog: readonly { capabilityKey: string; label: string }[],
  acts: readonly { connector: string; acts: readonly { category: string }[] }[],
  order: readonly string[]
): ConnectorRow[] {
  const actsByKey = new Map(acts.map((group) => [group.connector, group.acts]));
  const seen = new Set<string>();
  return catalog
    .filter((entry) => {
      if (seen.has(entry.capabilityKey)) return false;
      seen.add(entry.capabilityKey);
      return actsByKey.has(entry.capabilityKey);
    })
    .map((entry) => {
      const present = new Set(actsByKey.get(entry.capabilityKey)?.map((act) => act.category));
      return {
        key: entry.capabilityKey,
        label: entry.label,
        categories: order.filter((category) => category === 'other' || present.has(category)),
      };
    });
}
