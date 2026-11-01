/**
 * The Preferences form's "What a chat may do", with no React: the rule
 * each tool has, the connector-wide "all", what a shut fold's line says,
 * the decisions kept for tools no longer listed, when Save is on, and
 * what a save leaves on screen. tool-permissions-form.tsx renders from
 * this and makes the PUT. Tested in tool-permissions-form.model.test.ts.
 *
 * Nothing is saved until Save: a person working through a connector
 * should not fire a request per click.
 */

import {
  parseChatToolPermissionPrefs,
  ruleFor,
  withRule,
  type ActToolGroup,
  type ChatToolPermissionPrefs,
  type ToolPermissionRule,
} from '@/lib/chat/permission-rules';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface ToolPermissionsState {
  /** The lists as the person has them on screen. */
  prefs: ChatToolPermissionPrefs;
  /** The lists as last stored. */
  saved: ChatToolPermissionPrefs;
  status: SaveStatus;
}

export type ToolPermissionsAction =
  | { type: 'set-rule'; name: string; rule: ToolPermissionRule }
  | { type: 'set-all'; group: ActToolGroup; rule: ToolPermissionRule }
  | { type: 'save-started' }
  /** The server stored the lists; `stored` is its answer, read as the lists. */
  | { type: 'save-succeeded'; stored: unknown }
  | { type: 'save-failed' };

export function initToolPermissions(initial: ChatToolPermissionPrefs): ToolPermissionsState {
  return { prefs: initial, saved: initial, status: 'idle' };
}

function edited(state: ToolPermissionsState, prefs: ChatToolPermissionPrefs): ToolPermissionsState {
  return { ...state, prefs, status: 'idle' };
}

export function toolPermissionsReducer(
  state: ToolPermissionsState,
  action: ToolPermissionsAction
): ToolPermissionsState {
  switch (action.type) {
    case 'set-rule':
      return edited(state, withRule(state.prefs, action.name, action.rule));
    case 'set-all': {
      let next = state.prefs;
      for (const tool of action.group.tools) next = withRule(next, tool.name, action.rule);
      return edited(state, next);
    }
    case 'save-started':
      return { ...state, status: 'saving' };
    case 'save-succeeded': {
      const stored = parseChatToolPermissionPrefs(action.stored);
      return { prefs: stored, saved: stored, status: 'saved' };
    }
    case 'save-failed':
      return { ...state, status: 'failed' };
  }
}

/** The lists on screen differ from the stored ones. */
export function isDirty(state: ToolPermissionsState): boolean {
  return (
    state.prefs.alwaysAllow.join('\n') !== state.saved.alwaysAllow.join('\n') ||
    state.prefs.alwaysDeny.join('\n') !== state.saved.alwaysDeny.join('\n')
  );
}

/** Save is on when something changed and no save is on its way. */
export function canSave(state: ToolPermissionsState): boolean {
  return state.status !== 'saving' && isDirty(state);
}

/** What Save sends: both lists, whole. */
export function saveBody(state: ToolPermissionsState): ChatToolPermissionPrefs {
  return state.prefs;
}

/**
 * A fold's line, so a shut fold still says where the decisions are:
 * "1 allowed, 1 blocked", or "N ask" when nothing is decided.
 */
export function groupSummary(group: ActToolGroup, prefs: ChatToolPermissionPrefs): string {
  const allowed = group.tools.filter((tool) => ruleFor(prefs, tool.name) === 'allow').length;
  const blocked = group.tools.filter((tool) => ruleFor(prefs, tool.name) === 'deny').length;
  const parts = [
    allowed > 0 ? `${allowed} allowed` : null,
    blocked > 0 ? `${blocked} blocked` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(', ') : `${group.tools.length} ask`;
}

/**
 * Decisions saved for tools this build no longer lists (a connector
 * turned off, a tool renamed) — kept, and said, rather than silently
 * dropped on the next Save.
 */
export function unlistedDecisions(
  groups: ActToolGroup[],
  prefs: ChatToolPermissionPrefs
): { name: string; rule: 'allow' | 'deny' }[] {
  const listed = new Set(groups.flatMap((group) => group.tools.map((tool) => tool.name)));
  return [...prefs.alwaysAllow, ...prefs.alwaysDeny]
    .filter((name) => !listed.has(name))
    .map((name) => ({ name, rule: prefs.alwaysDeny.includes(name) ? 'deny' : 'allow' }));
}
