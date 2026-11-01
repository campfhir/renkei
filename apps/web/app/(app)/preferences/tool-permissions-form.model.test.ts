/**
 * "What a chat may do" on the Preferences page (tool-permissions-form.model.ts):
 * Ask, Allow or Block per tool, a connector-wide "all", a shut fold that
 * still says where the decisions are, decisions kept for tools no longer
 * listed, and Save — on only when something changed, sending both lists,
 * showing what was stored. chat-permission.spec.ts used to press through
 * these; the route's side is app/api/chat/chats/[chatId]/turns/[turnId]/permission/route.test.ts.
 */

import type { ActToolGroup } from '@/lib/chat/permission-rules';
import {
  canSave,
  groupSummary,
  initToolPermissions,
  isDirty,
  saveBody,
  toolPermissionsReducer,
  unlistedDecisions,
  type ToolPermissionsAction,
  type ToolPermissionsState,
} from './tool-permissions-form.model';

const own: ActToolGroup = {
  key: 'renkei-chat',
  label: 'The chat itself',
  tools: [
    { name: 'chat_memory_forget', label: 'Forget' },
    { name: 'chat_memory_remember', label: 'Remember' },
    { name: 'chat_rename', label: 'Rename' },
  ],
};

const fold = (
  actions: ToolPermissionsAction[],
  from: ToolPermissionsState = initToolPermissions({
    alwaysAllow: ['chat_memory_remember'],
    alwaysDeny: [],
  })
) => actions.reduce(toolPermissionsReducer, from);

describe('what a chat may do', () => {
  it('opens with what is stored, and Save off', () => {
    const state = fold([]);
    expect(state.status).toBe('idle');
    expect(isDirty(state)).toBe(false);
    expect(canSave(state)).toBe(false);
  });

  it('a shut fold says how many of its tools are allowed and blocked', () => {
    const state = fold([{ type: 'set-rule', name: 'chat_memory_forget', rule: 'deny' }]);
    expect(groupSummary(own, fold([]).prefs)).toBe('1 allowed');
    expect(groupSummary(own, state.prefs)).toBe('1 allowed, 1 blocked');
    expect(groupSummary(own, { alwaysAllow: [], alwaysDeny: [] })).toBe('3 ask');
  });

  it('blocking a tool turns Save on; putting it back turns it off again', () => {
    const blocked = fold([{ type: 'set-rule', name: 'chat_memory_forget', rule: 'deny' }]);
    expect(canSave(blocked)).toBe(true);
    const back = fold([{ type: 'set-rule', name: 'chat_memory_forget', rule: 'ask' }], blocked);
    expect(canSave(back)).toBe(false);
  });

  it('a tool is never both allowed and blocked', () => {
    const state = fold([{ type: 'set-rule', name: 'chat_memory_remember', rule: 'deny' }]);
    expect(state.prefs).toEqual({ alwaysAllow: [], alwaysDeny: ['chat_memory_remember'] });
  });

  it('“all” sets every tool of the connector at once', () => {
    const state = fold([{ type: 'set-all', group: own, rule: 'allow' }]);
    expect(state.prefs.alwaysAllow).toEqual([
      'chat_memory_forget',
      'chat_memory_remember',
      'chat_rename',
    ]);
    expect(groupSummary(own, state.prefs)).toBe('3 allowed');
    expect(fold([{ type: 'set-all', group: own, rule: 'ask' }], state).prefs.alwaysAllow).toEqual(
      []
    );
  });

  it('Save sends both lists whole, is off while it is on its way, and shows what was stored', () => {
    const edited = fold([
      { type: 'set-rule', name: 'chat_memory_remember', rule: 'ask' },
      { type: 'set-rule', name: 'chat_memory_forget', rule: 'deny' },
    ]);
    expect(saveBody(edited)).toEqual({ alwaysAllow: [], alwaysDeny: ['chat_memory_forget'] });
    const saving = fold([{ type: 'save-started' }], edited);
    expect(canSave(saving)).toBe(false);
    const saved = fold(
      [{ type: 'save-succeeded', stored: { alwaysAllow: [], alwaysDeny: ['chat_memory_forget'] } }],
      saving
    );
    expect(saved.status).toBe('saved');
    expect(isDirty(saved)).toBe(false);
    expect(canSave(saved)).toBe(false);
  });

  it('shows the lists as the server stored them, not as sent', () => {
    const saved = fold([
      { type: 'set-rule', name: 'chat_rename', rule: 'allow' },
      { type: 'save-started' },
      { type: 'save-succeeded', stored: { alwaysAllow: ['chat_rename', 'x'], alwaysDeny: ['x'] } },
    ]);
    expect(saved.prefs).toEqual({ alwaysAllow: ['chat_rename'], alwaysDeny: ['x'] });
  });

  it('a failed save keeps the edits and Save on; the next edit clears the message', () => {
    const failed = fold([
      { type: 'set-rule', name: 'chat_rename', rule: 'deny' },
      { type: 'save-started' },
      { type: 'save-failed' },
    ]);
    expect(failed.status).toBe('failed');
    expect(failed.prefs.alwaysDeny).toEqual(['chat_rename']);
    expect(canSave(failed)).toBe(true);
    expect(fold([{ type: 'set-rule', name: 'chat_rename', rule: 'allow' }], failed).status).toBe(
      'idle'
    );
  });

  it('keeps, and says, the decisions for tools not listed right now, until asked again', () => {
    const state = fold(
      [],
      initToolPermissions({ alwaysAllow: ['gone_allow'], alwaysDeny: ['gone_deny'] })
    );
    expect(unlistedDecisions([own], state.prefs)).toEqual([
      { name: 'gone_allow', rule: 'allow' },
      { name: 'gone_deny', rule: 'deny' },
    ]);
    const asked = fold([{ type: 'set-rule', name: 'gone_deny', rule: 'ask' }], state);
    expect(unlistedDecisions([own], asked.prefs)).toEqual([{ name: 'gone_allow', rule: 'allow' }]);
    expect(canSave(asked)).toBe(true);
  });
});
