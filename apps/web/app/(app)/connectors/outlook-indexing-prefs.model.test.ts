import {
  CATEGORIES,
  initialOutlookPrefs,
  isChecked,
  noticeFor,
  outlookPrefsReducer,
  prefsOf,
  refusalNotice,
  toggleEnabled,
  toggleRequest,
  type OutlookPrefsAction,
  type OutlookPrefsState,
} from './outlook-indexing-prefs.model';

function run(...actions: OutlookPrefsAction[]): OutlookPrefsState {
  return actions.reduce(outlookPrefsReducer, initialOutlookPrefs);
}

const loadedOff: OutlookPrefsAction = { type: 'loaded', prefs: { mail: false } };

describe('What runs in the background (Outlook)', () => {
  it('offers exactly one toggle, Mail, saying it wakes agents and never indexes', () => {
    expect(CATEGORIES.map((category) => category.label)).toEqual(['Mail']);
    expect(CATEGORIES[0].hint).toMatch(/"An email arrives" trigger/);
    expect(CATEGORIES[0].hint).toMatch(/never indexed/);
    expect(CATEGORIES.some((category) => /Calendar|Tasks|To Do/.test(category.label))).toBe(false);
  });

  it('is unticked and cannot be clicked until the saved choice is read', () => {
    const state = run();
    expect(isChecked(state, 'mail')).toBe(false);
    expect(toggleEnabled(state)).toBe(false);
  });

  it('reads the saved choice, off by default', () => {
    expect(prefsOf({ indexing: { mail: false } })).toEqual({ mail: false });
    expect(prefsOf({ indexing: { mail: true, calendar: true } })).toEqual({ mail: true });
    expect(prefsOf({ error: 'Microsoft is not connected' })).toBeNull();
    const state = run(loadedOff);
    expect(isChecked(state, 'mail')).toBe(false);
    expect(toggleEnabled(state)).toBe(true);
  });

  it('a click ticks the box at once, sends the whole choice, and holds the toggle while saving', () => {
    const state = run(loadedOff, { type: 'toggled', key: 'mail', on: true });
    expect(isChecked(state, 'mail')).toBe(true);
    expect(toggleEnabled(state)).toBe(false);
    expect(state.notice).toBeNull();
    expect(toggleRequest({ mail: false }, 'mail', true)).toEqual({ mail: true });
  });

  it('opting in says new mail will start waking agents, and that nothing is indexed', () => {
    const state = run(
      loadedOff,
      { type: 'toggled', key: 'mail', on: true },
      { type: 'saved', on: true }
    );
    expect(state.notice).toBe(noticeFor(true));
    expect(state.notice).toMatch(/start waking agents/);
    expect(state.notice).toMatch(/Nothing is indexed/);
    expect(toggleEnabled(state)).toBe(true);
  });

  it('opting out says new mail no longer wakes agents', () => {
    const state = run(
      { type: 'loaded', prefs: { mail: true } },
      { type: 'toggled', key: 'mail', on: false },
      { type: 'saved', on: false }
    );
    expect(isChecked(state, 'mail')).toBe(false);
    expect(state.notice).toBe('New mail no longer wakes your agents.');
  });

  it('a refused save puts the toggle back and says why', () => {
    const state = run(
      loadedOff,
      { type: 'toggled', key: 'mail', on: true },
      {
        type: 'failed',
        previous: { mail: false },
        notice: refusalNotice({ error: 'Database unavailable' }),
      }
    );
    expect(isChecked(state, 'mail')).toBe(false);
    expect(state.notice).toBe('Database unavailable');
    expect(toggleEnabled(state)).toBe(true);
  });

  it('a refusal without words says "Could not save."', () => {
    expect(refusalNotice(null)).toBe('Could not save.');
    expect(refusalNotice({})).toBe('Could not save.');
  });

  it('a click before the choice is read does nothing', () => {
    expect(run({ type: 'toggled', key: 'mail', on: true })).toEqual(initialOutlookPrefs);
  });
});
