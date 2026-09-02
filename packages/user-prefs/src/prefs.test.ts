/**
 * The precedence table, and the parser that has to survive whatever jsonb
 * hands back. Both matter for the same reason: preferences are applied at
 * WRITE time, so getting one wrong does not hide a notification — it means
 * the notification never existed and cannot be recovered by fixing the bug.
 */

import {
  BATCH_EVENTS,
  DEFAULT_NOTIFICATION_PREFS,
  batchEventForStatus,
  defaultForCategory,
  deliveryForCategory,
  effectiveDelivery,
  effectivePauseDelivery,
  parseNotificationPrefs,
  wantsAct,
  type NotificationPrefs,
  type DeliveryPrefs,
} from './prefs';

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...over,
});

const delivery = (over: Partial<DeliveryPrefs>): DeliveryPrefs => ({
  app: false,
  email: false,
  webex: false,
  ...over,
});

describe('defaults', () => {
  it('says yes to the five curated categories on App', () => {
    for (const category of ['created', 'sent', 'updated', 'deleted', 'scheduled']) {
      expect(defaultForCategory(category)).toBe(true);
    }
  });

  it('says no to "other" — the uncurated majority', () => {
    // Every act tool with no declared outcome lands here. On by default it
    // would bury the categories that carry a real sentence.
    expect(defaultForCategory('other')).toBe(false);
  });

  it('does not announce a run starting', () => {
    expect(DEFAULT_NOTIFICATION_PREFS.runStarted).toEqual({
      app: false,
      email: false,
      webex: false,
    });
    expect(DEFAULT_NOTIFICATION_PREFS.runFinished).toEqual({
      app: true,
      email: false,
      webex: false,
    });
    expect(DEFAULT_NOTIFICATION_PREFS.runFailed).toEqual({
      app: true,
      email: false,
      webex: false,
    });
    expect(DEFAULT_NOTIFICATION_PREFS.agentEditedByOthers).toEqual({
      app: true,
      email: false,
      webex: false,
    });
  });

  it('starts email and WebEx off for approvals and questions', () => {
    expect(DEFAULT_NOTIFICATION_PREFS.approvalNeeded).toEqual({ email: false, webex: false });
    expect(DEFAULT_NOTIFICATION_PREFS.questionAsked).toEqual({ email: false, webex: false });
  });
});

describe('deliveryForCategory / wantsAct', () => {
  it('falls back to the category default on App, and off on Email/WebEx', () => {
    expect(deliveryForCategory(prefs(), 'jira', 'created')).toEqual(
      delivery({ app: true })
    );
    expect(deliveryForCategory(prefs(), 'jira', 'other')).toEqual(delivery({ app: false }));
    expect(wantsAct(prefs(), 'jira', 'created', 'app')).toBe(true);
    expect(wantsAct(prefs(), 'jira', 'created', 'email')).toBe(false);
    expect(wantsAct(prefs(), 'jira', 'created', 'webex')).toBe(false);
  });

  it('lets a stored entry override all three channels at once', () => {
    const p = prefs({ acts: { jira: { created: delivery({ app: false, email: true }) } } });
    expect(wantsAct(p, 'jira', 'created', 'app')).toBe(false);
    expect(wantsAct(p, 'jira', 'created', 'email')).toBe(true);
    expect(wantsAct(p, 'jira', 'created', 'webex')).toBe(false);
  });

  it('scopes the grid to its own connector', () => {
    const p = prefs({ acts: { jira: { created: delivery({ app: false }) } } });
    expect(wantsAct(p, 'jira', 'created', 'app')).toBe(false);
    expect(wantsAct(p, 'microsoft', 'created', 'app')).toBe(true);
  });

  it('only applies a layer where it was actually set', () => {
    // A grid entry for a DIFFERENT category must not shadow this one.
    const p = prefs({ acts: { jira: { deleted: delivery({ app: false }) } } });
    expect(wantsAct(p, 'jira', 'created', 'app')).toBe(true);
  });

  it('handles an act with no connector attribution', () => {
    expect(wantsAct(prefs(), null, 'created', 'app')).toBe(true);
    expect(
      wantsAct(prefs({ acts: { jira: { created: delivery({ app: false }) } } }), null, 'created', 'app')
    ).toBe(true);
  });
});

describe('parseNotificationPrefs', () => {
  it('fills every default from an empty object', () => {
    expect(parseNotificationPrefs({})).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', ['nope']],
    ['a number', 42],
  ])('falls back to the defaults for %s', (_label, stored) => {
    expect(parseNotificationPrefs(stored)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('keeps what it recognises and drops what it does not', () => {
    const parsed = parseNotificationPrefs({
      runStarted: true,
      runFinished: 'yes',
      approvalNeeded: { email: true, webex: 'nope' },
      acts: {
        jira: { created: { app: false, email: true, webex: 'nope' }, bogus: 'x' },
        empty: {},
      },
      toastCorner: 'top-left',
      // A key from a build that still stored this — ignored, same as any
      // other unrecognised property.
      tools: { jira_create_issue: true },
      unknownKey: 'ignored',
    });
    // A bare boolean migrates to the App channel alone (see the dedicated
    // migration test below).
    expect(parsed.runStarted).toEqual({ app: true, email: false, webex: false });
    // A non-boolean, non-object value is not a preference; the default stands.
    expect(parsed.runFinished).toEqual({ app: true, email: false, webex: false });
    expect(parsed.approvalNeeded).toEqual({ email: true, webex: false });
    // "bogus" isn't a valid {app,email,webex} triple, so it's dropped
    // rather than invented as a default-valued entry.
    expect(parsed.acts).toEqual({
      jira: { created: { app: false, email: true, webex: false } },
    });
    // Only two corners exist; anything else means the default one.
    expect(parsed.toastCorner).toBe('bottom-right');
    // 'tools' is gone from the type entirely now — nothing to assert beyond
    // that the object above type-checks without it.
  });

  it('reads a pre-migration plain boolean as the App channel alone, not the default', () => {
    // runFailed and every acts[connector][category] entry used to BE a
    // plain boolean. Someone's saved "off" from before this shape existed
    // must still read as off — not silently reset to the (on) default the
    // next time this loads, which is what treating it as "unrecognised"
    // would do.
    const parsed = parseNotificationPrefs({
      runFailed: false,
      acts: { jira: { created: false, other: true } },
    });
    expect(parsed.runFailed).toEqual({ app: false, email: false, webex: false });
    expect(parsed.acts).toEqual({
      jira: {
        created: { app: false, email: false, webex: false },
        other: { app: true, email: false, webex: false },
      },
    });
  });

  it('accepts the other corner', () => {
    expect(parseNotificationPrefs({ toastCorner: 'bottom-left' }).toastCorner).toBe('bottom-left');
  });

  it('round-trips its own output', () => {
    const once = parseNotificationPrefs({
      runStarted: true,
      acts: { webex: { sent: { app: false, email: false, webex: true } } },
      approvalNeeded: { email: true, webex: false },
      toastCorner: 'bottom-left',
      toastsEnabled: false,
      agentOverrides: {
        'agent-1': { runFailed: { app: true, email: true, webex: false } },
      },
    });
    expect(parseNotificationPrefs(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  describe('agentOverrides', () => {
    it('defaults to no overrides', () => {
      expect(parseNotificationPrefs({}).agentOverrides).toEqual({});
    });

    it('keeps a valid override, migrating a bare boolean the same as the general prefs', () => {
      const parsed = parseNotificationPrefs({
        agentOverrides: {
          'agent-1': {
            runFailed: true,
            approvalNeeded: { email: true, webex: false },
            bogusKey: 'ignored',
          },
        },
      });
      expect(parsed.agentOverrides).toEqual({
        'agent-1': {
          runFailed: { app: true, email: false, webex: false },
          approvalNeeded: { email: true, webex: false },
        },
      });
    });

    it('drops an agent id whose entry has nothing usable', () => {
      const parsed = parseNotificationPrefs({
        agentOverrides: {
          'agent-1': { bogusKey: 'nope' },
          'agent-2': 'not an object',
        },
      });
      expect(parsed.agentOverrides).toEqual({});
    });

    it('ignores a non-object agentOverrides value', () => {
      expect(parseNotificationPrefs({ agentOverrides: 'nope' }).agentOverrides).toEqual({});
      expect(parseNotificationPrefs({ agentOverrides: ['nope'] }).agentOverrides).toEqual({});
    });
  });
});

describe('effectiveDelivery / effectivePauseDelivery', () => {
  it('falls back to the general preference when there is no agent id', () => {
    const p = prefs({
      agentOverrides: { 'agent-1': { runFailed: delivery({ email: true }) } },
    });
    expect(effectiveDelivery(p, null, 'runFailed')).toEqual(p.runFailed);
    expect(effectiveDelivery(p, undefined, 'runFailed')).toEqual(p.runFailed);
  });

  it('falls back to the general preference when the agent has no override for this key', () => {
    const p = prefs({
      agentOverrides: { 'agent-1': { runFinished: delivery({ email: true }) } },
    });
    expect(effectiveDelivery(p, 'agent-1', 'runFailed')).toEqual(p.runFailed);
    expect(effectiveDelivery(p, 'agent-2', 'runFinished')).toEqual(p.runFinished);
  });

  it('uses the agent override when one is set for this key', () => {
    const override = delivery({ app: false, email: true, webex: true });
    const p = prefs({ agentOverrides: { 'agent-1': { runFailed: override } } });
    expect(effectiveDelivery(p, 'agent-1', 'runFailed')).toEqual(override);
  });

  it('does the same for the pause events', () => {
    const override = { email: true, webex: true };
    const p = prefs({ agentOverrides: { 'agent-1': { approvalNeeded: override } } });
    expect(effectivePauseDelivery(p, 'agent-1', 'approvalNeeded')).toEqual(override);
    expect(effectivePauseDelivery(p, 'agent-1', 'questionAsked')).toEqual(p.questionAsked);
    expect(effectivePauseDelivery(p, null, 'approvalNeeded')).toEqual(p.approvalNeeded);
  });
});

describe('batch events', () => {
  it('defaults like the run events: started off, finished and failed on in the app only', () => {
    expect(DEFAULT_NOTIFICATION_PREFS.batchStarted).toEqual(delivery({}));
    expect(DEFAULT_NOTIFICATION_PREFS.batchFinished).toEqual(delivery({ app: true }));
    expect(DEFAULT_NOTIFICATION_PREFS.batchFailed).toEqual(delivery({ app: true }));
  });

  it('parses stored choices and fills the rest', () => {
    const parsed = parseNotificationPrefs({
      batchStarted: { app: true },
      batchFailed: { email: true, webex: true },
    });
    expect(parsed.batchStarted).toEqual(delivery({ app: true }));
    expect(parsed.batchFinished).toEqual(DEFAULT_NOTIFICATION_PREFS.batchFinished);
    expect(parsed.batchFailed).toEqual(delivery({ app: true, email: true, webex: true }));
  });

  it('routes a terminal status to its event — partial is a finish, not a failure', () => {
    expect(batchEventForStatus('succeeded')).toBe('batchFinished');
    expect(batchEventForStatus('partial')).toBe('batchFinished');
    expect(batchEventForStatus('failed')).toBe('batchFailed');
  });

  it('lists the three events in the order a page shows them', () => {
    expect(BATCH_EVENTS).toEqual(['batchStarted', 'batchFinished', 'batchFailed']);
  });
});
