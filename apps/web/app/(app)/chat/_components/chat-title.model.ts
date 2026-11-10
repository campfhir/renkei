/**
 * The chat's name in the title bar, renamed in place, with no React: when
 * the field opens, what leaving it does (save a new name, or just close
 * when the name is empty or unchanged), and that a save in flight is not
 * started twice. chat-title.tsx renders from this and calls onRename.
 * Tested in chat-title.model.test.ts.
 */

export interface ChatTitleState {
  editing: boolean;
  draft: string;
  saving: boolean;
}

export type ChatTitleAction =
  /** A double-click on the name, or the pencil: the field opens on the current name. */
  | { type: 'start'; title: string; canRename: boolean }
  | { type: 'type'; draft: string }
  /** Escape: the old name comes back. */
  | { type: 'cancel' }
  | { type: 'save-started' }
  /** The rename settled, whatever the server said: the field closes. */
  | { type: 'save-finished' };

export function initChatTitle(title: string): ChatTitleState {
  return { editing: false, draft: title, saving: false };
}

export function chatTitleReducer(state: ChatTitleState, action: ChatTitleAction): ChatTitleState {
  switch (action.type) {
    case 'start':
      return action.canRename ? { ...state, editing: true, draft: action.title } : state;
    case 'type':
      return { ...state, draft: action.draft };
    case 'cancel':
      return { ...state, editing: false };
    case 'save-started':
      return { ...state, saving: true };
    case 'save-finished':
      return { ...state, saving: false, editing: false };
  }
}

/**
 * What Enter or leaving the field does: nothing while a save is on its way;
 * close without a request when the name is empty or the same; otherwise
 * save the trimmed name.
 */
export function commitRename(
  state: ChatTitleState,
  title: string
): { kind: 'ignore' } | { kind: 'close' } | { kind: 'save'; title: string } {
  if (state.saving) return { kind: 'ignore' };
  const next = state.draft.trim();
  if (!next || next === title) return { kind: 'close' };
  return { kind: 'save', title: next };
}
