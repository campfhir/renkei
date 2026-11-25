import type { ActToolGroup } from '@/lib/chat/permission-rules';
import {
  canSave,
  canUseDefault,
  groupSummary,
  highRiskFormReducer,
  initHighRiskForm,
  isLocked,
  isOn,
  saveBody,
  totalOn,
  unlistedNames,
  visibleGroups,
  type HighRiskFormAction,
  type HighRiskFormState,
} from './high-risk-form.model';

const OUTLOOK: ActToolGroup = {
  key: 'outlook',
  label: 'Outlook',
  tools: [
    { name: 'outlook_send_mail', label: 'Send mail' },
    { name: 'outlook_create_draft', label: 'Create a draft' },
  ],
};
const CODE: ActToolGroup = {
  key: 'code',
  label: 'Code projects',
  tools: [
    { name: 'code_git_commit', label: 'Commit' },
    { name: 'code_git_push', label: 'Push' },
  ],
};
const GITHUB: ActToolGroup = {
  key: 'github',
  label: 'GitHub',
  tools: [
    { name: 'github_create_pull_request', label: 'Create a pull request' },
    { name: 'github_merge_pull_request', label: 'Merge a pull request' },
  ],
};
const LOCKED = ['outlook_send_mail', 'github_merge_pull_request'];

const fold = (state: HighRiskFormState, ...actions: HighRiskFormAction[]) =>
  actions.reduce(highRiskFormReducer, state);

describe('Preferences › Agents: my high-risk tools', () => {
  const start = () => initHighRiskForm({ kind: 'agents', locked: LOCKED });

  it("shows the organization's locked tools on and nothing else, with Save off", () => {
    const state = start();
    expect(isOn(state, 'outlook_send_mail')).toBe(true);
    expect(isLocked(state, 'outlook_send_mail')).toBe(true);
    expect(isOn(state, 'outlook_create_draft')).toBe(false);
    expect(canSave(state)).toBe(false);
    expect(groupSummary(state, OUTLOOK)).toBe('1 high risk of 2');
  });

  it('a locked tool cannot be switched off, not even by "all of Outlook"', () => {
    let state = fold(start(), { type: 'set', name: 'outlook_send_mail', on: false });
    expect(isOn(state, 'outlook_send_mail')).toBe(true);
    expect(canSave(state)).toBe(false);
    state = fold(state, { type: 'set-all', group: OUTLOOK, on: true });
    state = fold(state, { type: 'set-all', group: OUTLOOK, on: false });
    expect(isOn(state, 'outlook_send_mail')).toBe(true);
    expect(isOn(state, 'outlook_create_draft')).toBe(false);
  });

  it('marking a tool turns Save on and sends it as a departure from the default', () => {
    const state = fold(start(), { type: 'set', name: 'outlook_create_draft', on: true });
    expect(canSave(state)).toBe(true);
    expect(saveBody(state)).toEqual({
      kind: 'agents',
      marked: ['outlook_create_draft'],
      unmarked: [],
    });
  });

  it('a save leaves what the server stored on screen, Save off and "Saved." shown', () => {
    const state = fold(
      start(),
      { type: 'set', name: 'outlook_create_draft', on: true },
      { type: 'save-started' },
      { type: 'save-succeeded', stored: { marked: ['outlook_create_draft'], unmarked: [] } }
    );
    expect(state.status).toBe('saved');
    expect(canSave(state)).toBe(false);
    expect(isOn(state, 'outlook_create_draft')).toBe(true);
  });

  it('a failed save keeps the change and Save on, saying it did not save', () => {
    const state = fold(
      start(),
      { type: 'set', name: 'outlook_create_draft', on: true },
      { type: 'save-started' },
      { type: 'save-failed' }
    );
    expect(state.status).toBe('failed');
    expect(canSave(state)).toBe(true);
    expect(isOn(state, 'outlook_create_draft')).toBe(true);
  });

  it('nothing to save while a save is on its way', () => {
    const state = fold(
      start(),
      { type: 'set', name: 'outlook_create_draft', on: true },
      { type: 'save-started' }
    );
    expect(canSave(state)).toBe(false);
  });
});

describe('Preferences › Code projects: high risk in Auto mode', () => {
  const start = () => initHighRiskForm({ kind: 'code', locked: LOCKED });

  it("starts with everything high risk except the checkout's own work", () => {
    const state = start();
    expect(isOn(state, 'code_git_commit')).toBe(false);
    expect(isOn(state, 'code_git_push')).toBe(false);
    expect(isOn(state, 'github_create_pull_request')).toBe(true);
    expect(totalOn(state, [CODE, GITHUB])).toBe(2);
    expect(canUseDefault(state)).toBe(false);
  });

  it('switching off a tool the default holds, then "use the default", puts it back', () => {
    let state = fold(start(), { type: 'set', name: 'github_create_pull_request', on: false });
    expect(saveBody(state)).toEqual({
      kind: 'code',
      marked: [],
      unmarked: ['github_create_pull_request'],
    });
    expect(canUseDefault(state)).toBe(true);
    state = fold(state, { type: 'use-default' });
    expect(isOn(state, 'github_create_pull_request')).toBe(true);
    expect(canSave(state)).toBe(false);
  });

  it('the filter narrows to matching tools or a matching connector, and says so in the count', () => {
    const state = fold(start(), { type: 'filter', text: 'push' });
    expect(visibleGroups(state, [CODE, GITHUB])).toEqual([
      { ...CODE, tools: [{ name: 'code_git_push', label: 'Push' }] },
    ]);
    expect(
      visibleGroups(fold(start(), { type: 'filter', text: 'github' }), [CODE, GITHUB])
    ).toEqual([GITHUB]);
  });
});

describe('Settings › Locked high-risk tools (operators)', () => {
  const start = () => initHighRiskForm({ kind: 'org', locked: LOCKED });

  it('the operator can switch a locked tool off and another on; Save sends the whole list', () => {
    const state = fold(
      start(),
      { type: 'set', name: 'outlook_send_mail', on: false },
      { type: 'set', name: 'outlook_create_draft', on: true }
    );
    expect(isLocked(state, 'outlook_create_draft')).toBe(false);
    expect(saveBody(state)).toEqual({
      tools: ['github_merge_pull_request', 'outlook_create_draft'],
    });
    expect(groupSummary(state, OUTLOOK)).toBe('1 locked of 2');
  });

  it('"undo changes" goes back to the saved list', () => {
    const state = fold(
      start(),
      { type: 'set-all', group: GITHUB, on: false },
      { type: 'use-default' }
    );
    expect(canSave(state)).toBe(false);
    expect(isOn(state, 'github_merge_pull_request')).toBe(true);
  });

  it('a save reads back the stored list', () => {
    const state = fold(
      start(),
      { type: 'set', name: 'outlook_send_mail', on: false },
      { type: 'save-started' },
      { type: 'save-succeeded', stored: { tools: ['github_merge_pull_request'] } }
    );
    expect(state.locked).toEqual(['github_merge_pull_request']);
    expect(canSave(state)).toBe(false);
  });

  it('names no listed tool carries are said, not dropped', () => {
    const state = initHighRiskForm({ kind: 'org', locked: [...LOCKED, 'mirth_send_message'] });
    expect(unlistedNames(state, [OUTLOOK, GITHUB])).toEqual(['mirth_send_message']);
  });
});
