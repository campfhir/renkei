/**
 * The precedence table, and the parser that has to survive whatever jsonb
 * hands back. Both matter for the same reason: preferences are applied at
 * WRITE time, so getting one wrong does not hide a notification — it means
 * the notification never existed and cannot be recovered by fixing the bug.
 */

import {
  DEFAULT_NOTIFICATION_PREFS,
  defaultForCategory,
  parseNotificationPrefs,
  wantsAct,
  type NotificationPrefs,
} from './prefs';

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...over,
});

describe('defaults', () => {
  it('says yes to the five curated categories', () => {
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
    expect(DEFAULT_NOTIFICATION_PREFS.runStarted).toBe(false);
    expect(DEFAULT_NOTIFICATION_PREFS.runFinished).toBe(true);
    expect(DEFAULT_NOTIFICATION_PREFS.runFailed).toBe(true);
  });
});

describe('wantsAct precedence', () => {
  it('falls back to the category default when nothing is set', () => {
    expect(wantsAct(prefs(), 'jira', 'created', 'jira_create_issue')).toBe(true);
    expect(wantsAct(prefs(), 'jira', 'other', 'jira_add_attachment')).toBe(false);
  });

  it('lets the connector×category grid override the default, both ways', () => {
    expect(wantsAct(prefs({ acts: { jira: { created: false } } }), 'jira', 'created', null)).toBe(
      false
    );
    expect(wantsAct(prefs({ acts: { jira: { other: true } } }), 'jira', 'other', null)).toBe(true);
  });

  it('scopes the grid to its own connector', () => {
    const p = prefs({ acts: { jira: { created: false } } });
    expect(wantsAct(p, 'jira', 'created', null)).toBe(false);
    expect(wantsAct(p, 'microsoft', 'created', null)).toBe(true);
  });

  it('lets a per-tool switch beat the grid, both ways', () => {
    const off = prefs({
      acts: { jira: { created: true } },
      tools: { jira_create_issue: false },
    });
    expect(wantsAct(off, 'jira', 'created', 'jira_create_issue')).toBe(false);
    // And the reverse: everything in this category off, this one tool on.
    const on = prefs({
      acts: { jira: { other: false } },
      tools: { jira_add_attachment: true },
    });
    expect(wantsAct(on, 'jira', 'other', 'jira_add_attachment')).toBe(true);
  });

  it('only applies a layer where it was actually set', () => {
    // A grid entry for a DIFFERENT category must not shadow this one.
    const p = prefs({ acts: { jira: { deleted: false } } });
    expect(wantsAct(p, 'jira', 'created', 'jira_create_issue')).toBe(true);
    // And a tool switch for a different tool must not shadow this one.
    const q = prefs({ tools: { jira_delete_issue: false } });
    expect(wantsAct(q, 'jira', 'created', 'jira_create_issue')).toBe(true);
  });

  it('handles an act with no connector attribution', () => {
    expect(wantsAct(prefs(), null, 'created', null)).toBe(true);
    expect(wantsAct(prefs({ acts: { jira: { created: false } } }), null, 'created', null)).toBe(
      true
    );
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
      acts: { jira: { created: false, bogus: 'x' }, empty: {} },
      tools: { jira_create_issue: true, bogus: 1 },
      toastCorner: 'top-left',
      unknownKey: 'ignored',
    });
    expect(parsed.runStarted).toBe(true);
    // A non-boolean is not a preference; the default stands.
    expect(parsed.runFinished).toBe(true);
    expect(parsed.acts).toEqual({ jira: { created: false } });
    expect(parsed.tools).toEqual({ jira_create_issue: true });
    // Only two corners exist; anything else means the default one.
    expect(parsed.toastCorner).toBe('bottom-right');
  });

  it('accepts the other corner', () => {
    expect(parseNotificationPrefs({ toastCorner: 'bottom-left' }).toastCorner).toBe('bottom-left');
  });

  it('round-trips its own output', () => {
    const once = parseNotificationPrefs({
      runStarted: true,
      acts: { webex: { sent: false } },
      tools: { webex_send_message: true },
      toastCorner: 'bottom-left',
      toastsEnabled: false,
    });
    expect(parseNotificationPrefs(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});
