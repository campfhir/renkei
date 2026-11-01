/**
 * The notification preferences on the Preferences page, as a person
 * changes them. notifications.spec.ts's "acts enumerated per connector"
 * check is here now (the rows the page lays out, from the real act
 * catalog), with the switches' rules no spec checked.
 */

import { ACT_CATEGORIES, actsByConnector } from '@renkei/tool-outcomes';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@renkei/user-prefs/prefs';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import {
  categoryLabel,
  channelBox,
  connectorSummary,
  desktopView,
  initPreferences,
  notificationConnectorRows,
  overrideRow,
  preferencesReducer,
  saveRequest,
  type ConnectorRow,
  type PreferencesAction,
  type PreferencesState,
} from './preferences-form.model';

const fresh = (prefs: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS): PreferencesState =>
  initPreferences({ initial: prefs, agents: [{ id: 'agent-1' }, { id: 'agent-2' }] });

const run = (actions: PreferencesAction[], state = fresh()) =>
  actions.reduce(preferencesReducer, state);

const JIRA: ConnectorRow = {
  key: 'jira',
  label: 'Jira',
  categories: ['created', 'updated', 'other'],
};

describe('the connectors and their kinds of act', () => {
  const rows = notificationConnectorRows(CONNECTOR_CATALOG, actsByConnector(), ACT_CATEGORIES);
  const byLabel = (label: string) => rows.find((row) => row.label === label);

  it('lists everyday Jira’s acts as creates, updates and anything else', () => {
    const jira = byLabel('Jira');
    expect(jira?.categories).toEqual(expect.arrayContaining(['created', 'updated', 'other']));
    expect(jira?.categories.map((category) => categoryLabel(category).label)).toEqual(
      expect.arrayContaining(['Creates something', 'Updates something', 'Anything else'])
    );
  });

  it('lists Outlook’s sends', () => {
    expect(byLabel('Outlook')?.categories).toContain('sent');
  });

  it('gives each capability key one row, every row its catch-all last', () => {
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of rows) expect(row.categories[row.categories.length - 1]).toBe('other');
  });

  it('shares one row between connectors with one key, and drops a connector with no acts', () => {
    expect(
      notificationConnectorRows(
        [
          { capabilityKey: 'jira', label: 'Jira' },
          { capabilityKey: 'jira', label: 'Jira Service Management' },
          { capabilityKey: 'quiet', label: 'Quiet' },
        ],
        [{ connector: 'jira', acts: [{ category: 'updated' }, { category: 'created' }] }],
        ['created', 'sent', 'updated', 'other']
      )
    ).toEqual([{ key: 'jira', label: 'Jira', categories: ['created', 'updated', 'other'] }]);
  });

  it('names each kind, with a hint only for the catch-all', () => {
    expect(categoryLabel('sent')).toEqual({ label: 'Sends something', hint: null });
    expect(categoryLabel('other').hint).toMatch(/off to start with/);
    expect(categoryLabel('mystery')).toEqual({ label: 'mystery', hint: null });
  });
});

describe('a connector’s switches', () => {
  it('one channel of one kind changes alone, stored whole', () => {
    const { prefs } = run([
      {
        type: 'categoryChannel',
        connector: 'jira',
        category: 'created',
        channel: 'email',
        on: true,
      },
    ]);
    expect(prefs.acts.jira).toEqual({ created: { app: true, email: true, webex: false } });
  });

  it('the catch-all starts off in the app; the curated kinds on', () => {
    const summary = connectorSummary(DEFAULT_NOTIFICATION_PREFS, JIRA);
    expect(summary).toEqual({ appOn: 2, total: 3, anyExtraChannel: false });
  });

  it('"all" for a channel sets it on every kind, leaving the other channels as they were', () => {
    const { prefs } = run([
      {
        type: 'categoryChannel',
        connector: 'jira',
        category: 'created',
        channel: 'webex',
        on: true,
      },
      { type: 'wholeConnector', row: JIRA, channel: 'app', on: true },
    ]);
    expect(prefs.acts.jira).toEqual({
      created: { app: true, email: false, webex: true },
      updated: { app: true, email: false, webex: false },
      other: { app: true, email: false, webex: false },
    });
    expect(connectorSummary(prefs, JIRA)).toEqual({ appOn: 3, total: 3, anyExtraChannel: true });
  });

  it('a box for an unconnected channel reads off and cannot change, whatever is stored', () => {
    expect(channelBox(true, false)).toEqual({ checked: false, disabled: true });
    expect(channelBox(true, true)).toEqual({ checked: true, disabled: false });
    expect(channelBox(false, true)).toEqual({ checked: false, disabled: false });
  });
});

describe('events and pauses', () => {
  it('a run event’s channel changes alone', () => {
    const { prefs } = run([
      { type: 'deliveryChannel', event: 'runFailed', channel: 'webex', on: true },
    ]);
    expect(prefs.runFailed).toEqual({ ...DEFAULT_NOTIFICATION_PREFS.runFailed, webex: true });
    expect(prefs.runFinished).toEqual(DEFAULT_NOTIFICATION_PREFS.runFinished);
  });

  it('a pause can also page by email, with the app card untouched', () => {
    const { prefs } = run([
      { type: 'pauseChannel', event: 'approvalNeeded', channel: 'email', on: true },
    ]);
    expect(prefs.approvalNeeded).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS.approvalNeeded,
      email: true,
    });
  });

  it('pop-ups, their corner, chat replies and where a click lands are plain switches', () => {
    const { prefs } = run([
      { type: 'toastsEnabled', on: false },
      { type: 'toastCorner', corner: 'bottom-left' },
      { type: 'chatReplyDesktop', on: true },
      { type: 'openInSourceApp', on: false },
    ]);
    expect(prefs).toMatchObject({
      toastsEnabled: false,
      toastCorner: 'bottom-left',
      chatReplyDesktop: true,
      openInSourceApp: false,
    });
  });
});

describe('per-agent overrides', () => {
  it('the picker starts on the first agent', () => {
    expect(fresh().overrideAgentId).toBe('agent-1');
    expect(
      initPreferences({ initial: DEFAULT_NOTIFICATION_PREFS, agents: [] }).overrideAgentId
    ).toBe('');
  });

  it('without an override an agent shows the general preference, locked', () => {
    const row = overrideRow(DEFAULT_NOTIFICATION_PREFS, 'agent-1', 'runFinished');
    expect(row).toEqual({ overridden: false, effective: DEFAULT_NOTIFICATION_PREFS.runFinished });
  });

  it('switching an override on starts it as a copy of the general preference', () => {
    const { prefs } = run([
      { type: 'deliveryChannel', event: 'runFinished', channel: 'email', on: true },
      { type: 'overrideToggled', agentId: 'agent-1', event: 'runFinished', on: true },
    ]);
    expect(prefs.agentOverrides['agent-1'].runFinished).toEqual(prefs.runFinished);
  });

  it('an override’s channel changes the agent, not the general preference', () => {
    const { prefs } = run([
      { type: 'overrideToggled', agentId: 'agent-1', event: 'runFailed', on: true },
      {
        type: 'overrideChannel',
        agentId: 'agent-1',
        event: 'runFailed',
        channel: 'webex',
        on: true,
      },
    ]);
    expect(overrideRow(prefs, 'agent-1', 'runFailed').effective.webex).toBe(true);
    expect(prefs.runFailed.webex).toBe(false);
  });

  it('a channel press on an agent with no override changes nothing', () => {
    const before = fresh();
    const after = preferencesReducer(before, {
      type: 'overrideChannel',
      agentId: 'agent-1',
      event: 'runFailed',
      channel: 'webex',
      on: true,
    });
    expect(after.prefs).toEqual(before.prefs);
  });

  it('a pause override works the same way', () => {
    const { prefs } = run([
      { type: 'overrideToggled', agentId: 'agent-2', event: 'questionAsked', on: true },
      {
        type: 'overridePauseChannel',
        agentId: 'agent-2',
        event: 'questionAsked',
        channel: 'email',
        on: true,
      },
    ]);
    expect(prefs.agentOverrides['agent-2'].questionAsked?.email).toBe(true);
  });

  it('switching the last override off removes the agent’s entry altogether', () => {
    const { prefs } = run([
      { type: 'overrideToggled', agentId: 'agent-1', event: 'runFailed', on: true },
      { type: 'overrideToggled', agentId: 'agent-1', event: 'runStarted', on: true },
      { type: 'overrideToggled', agentId: 'agent-1', event: 'runFailed', on: false },
    ]);
    expect(Object.keys(prefs.agentOverrides['agent-1'])).toEqual(['runStarted']);
    const cleared = run(
      [{ type: 'overrideToggled', agentId: 'agent-1', event: 'runStarted', on: false }],
      { ...fresh(), prefs }
    );
    expect(cleared.prefs.agentOverrides).toEqual({});
  });

  it('picking another agent shows its overrides', () => {
    expect(run([{ type: 'overrideAgentPicked', agentId: 'agent-2' }]).overrideAgentId).toBe(
      'agent-2'
    );
  });
});

describe('Save', () => {
  it('sends the preferences as edited', () => {
    const state = run([{ type: 'toastsEnabled', on: false }]);
    expect(saveRequest(state)).toEqual({ notifications: state.prefs });
  });

  it('reads Saving…, then Saved. or Could not save.', () => {
    expect(run([{ type: 'saveSent' }]).status).toBe('saving');
    expect(run([{ type: 'saveSent' }, { type: 'saved' }]).status).toBe('saved');
    expect(run([{ type: 'saveSent' }, { type: 'saveFailed' }]).status).toBe('failed');
  });

  it('any change after a save takes "Saved." away', () => {
    const state = run([{ type: 'saved' }, { type: 'chatReplyDesktop', on: true }]);
    expect(state.status).toBe('idle');
  });
});

describe('browser notifications on this device', () => {
  it('reads this browser’s switch and permission once mounted', () => {
    const state = run([{ type: 'desktopRead', enabled: true, permission: 'granted' }]);
    expect(state.desktop).toEqual({ enabled: true, permission: 'granted', subscribeError: false });
  });

  it('turns on only when the browser allows it and the server hears about the device', () => {
    expect(run([{ type: 'desktopEnableAnswered', outcome: 'granted' }]).desktop).toEqual({
      enabled: true,
      permission: 'granted',
      subscribeError: false,
    });
  });

  it('stays off when the browser blocks it, and says so', () => {
    expect(run([{ type: 'desktopEnableAnswered', outcome: 'denied' }]).desktop).toEqual({
      enabled: false,
      permission: 'denied',
      subscribeError: false,
    });
  });

  it('stays off when the server never heard about the device, with its own sentence', () => {
    expect(run([{ type: 'desktopEnableAnswered', outcome: 'subscribe-failed' }]).desktop).toEqual({
      enabled: false,
      permission: 'granted',
      subscribeError: true,
    });
  });

  it('a browser that cannot show them disables the switch', () => {
    const state = run([{ type: 'desktopEnableAnswered', outcome: 'unsupported' }]);
    expect(desktopView(state).switchDisabled).toBe(true);
  });

  it('switching off clears the subscription error', () => {
    const state = run([
      { type: 'desktopEnableAnswered', outcome: 'subscribe-failed' },
      { type: 'desktopOff' },
    ]);
    expect(state.desktop).toMatchObject({ enabled: false, subscribeError: false });
  });

  it('offers "Allow notifications" when the switch is on but the browser went back to asking', () => {
    const drifted = run([{ type: 'desktopRead', enabled: true, permission: 'default' }]);
    expect(desktopView(drifted).showAllow).toBe(true);
    const allowed = run([{ type: 'permissionAnswered', permission: 'granted' }], drifted);
    expect(desktopView(allowed).showAllow).toBe(false);
    expect(
      desktopView(run([{ type: 'desktopRead', enabled: false, permission: 'default' }])).showAllow
    ).toBe(false);
  });

  it('a re-check of the subscription sets or clears its error', () => {
    expect(run([{ type: 'subscriptionChecked', ok: false }]).desktop.subscribeError).toBe(true);
    expect(run([{ type: 'subscriptionChecked', ok: true }]).desktop.subscribeError).toBe(false);
  });

  it('chat-reply pop-ups need the switch on', () => {
    expect(desktopView(fresh()).chatReplyDisabled).toBe(true);
    expect(
      desktopView(run([{ type: 'desktopEnableAnswered', outcome: 'granted' }])).chatReplyDisabled
    ).toBe(false);
  });
});
