/**
 * Renaming a chat from its title bar (chat-title.model.ts): the field
 * opens on the current name for the owner only, Escape puts the old name
 * back, and leaving the field saves a new, trimmed name — or just closes
 * when the name is empty or unchanged. The model's own chat_rename call is
 * chat-title.spec.ts's (and lib/chat/titles.test.ts's).
 */

import {
  chatTitleReducer,
  commitRename,
  initChatTitle,
  type ChatTitleAction,
  type ChatTitleState,
} from './chat-title.model';

const TITLE = 'Budget review';
const fold = (actions: ChatTitleAction[], from: ChatTitleState = initChatTitle(TITLE)) =>
  actions.reduce(chatTitleReducer, from);

describe('renaming a chat in its title bar', () => {
  it('opens the field on the current name for the owner', () => {
    expect(fold([{ type: 'start', title: TITLE, canRename: true }])).toEqual({
      editing: true,
      draft: TITLE,
      saving: false,
    });
  });

  it('does not open for someone who may not rename it', () => {
    expect(fold([{ type: 'start', title: TITLE, canRename: false }]).editing).toBe(false);
  });

  it('reopens on the name as it is now, not an abandoned draft', () => {
    const state = fold([
      { type: 'start', title: TITLE, canRename: true },
      { type: 'type', draft: 'Half typed' },
      { type: 'cancel' },
      { type: 'start', title: 'Renamed elsewhere', canRename: true },
    ]);
    expect(state.draft).toBe('Renamed elsewhere');
  });

  it('saves a new name, trimmed', () => {
    const state = fold([
      { type: 'start', title: TITLE, canRename: true },
      { type: 'type', draft: '  Quarterly budget review  ' },
    ]);
    expect(commitRename(state, TITLE)).toEqual({ kind: 'save', title: 'Quarterly budget review' });
  });

  it('just closes when the name is empty or unchanged', () => {
    const open = fold([{ type: 'start', title: TITLE, canRename: true }]);
    expect(commitRename(open, TITLE)).toEqual({ kind: 'close' });
    expect(commitRename(fold([{ type: 'type', draft: '   ' }], open), TITLE)).toEqual({
      kind: 'close',
    });
    expect(commitRename(fold([{ type: 'type', draft: ` ${TITLE} ` }], open), TITLE)).toEqual({
      kind: 'close',
    });
  });

  it('does not save twice while a save is on its way (Enter, then the field losing focus)', () => {
    const saving = fold([
      { type: 'start', title: TITLE, canRename: true },
      { type: 'type', draft: 'New' },
      { type: 'save-started' },
    ]);
    expect(commitRename(saving, TITLE)).toEqual({ kind: 'ignore' });
  });

  it('closes the field once the save settles', () => {
    expect(
      fold([
        { type: 'start', title: TITLE, canRename: true },
        { type: 'type', draft: 'New' },
        { type: 'save-started' },
        { type: 'save-finished' },
      ])
    ).toMatchObject({ editing: false, saving: false });
  });
});
