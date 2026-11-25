import {
  blockSave,
  pickerGroups,
  chatToolAnswerGroups,
  chatToolAnswerRows,
  chatToolAnswersCount,
  chatToolAnswersReducer,
  initialChatToolAnswersState,
  showsChatToolAnswers,
  type ChatToolAnswersAction,
} from './chat-tool-answers.model';

const fold = (...actions: ChatToolAnswersAction[]) =>
  actions.reduce(chatToolAnswersReducer, initialChatToolAnswersState);

const loaded = (answers: unknown): ChatToolAnswersAction => ({ type: 'loaded', answers });

const all = loaded({
  chat: { allow: ['card_update'], deny: ['card_create'] },
  always: { allow: ['outlook_create_draft'], deny: ['jira_delete_issue'] },
  locked: [],
});

describe('Decided here', () => {
  it('shows once loaded, listing no rows when no tool has a decision (they all ask)', () => {
    expect(showsChatToolAnswers(fold())).toBe(false);
    const none = fold(
      loaded({ chat: { allow: [], deny: [] }, always: { allow: [], deny: [] }, locked: [] })
    );
    expect(showsChatToolAnswers(none)).toBe(true);
    expect(chatToolAnswerRows(none)).toEqual([]);
    expect(chatToolAnswersCount(none)).toBe('');
  });

  it('each tag says what it means, and pressing it opens that explanation (one at a time)', () => {
    const rows = chatToolAnswerRows(fold(all));
    expect(rows.map((row) => row.tag.meaning)).toEqual([
      'Refused in this chat: if the model calls it here, the call is turned down.',
      'Refused in every chat: the model can never use it anywhere in Renkei.',
      'In this chat the model calls it without waiting for you to allow it.',
      'In every chat in Renkei the model calls it without waiting for you to allow it.',
    ]);
    const open = fold(all, { type: 'explain', tool: 'card_create' });
    expect(
      chatToolAnswerRows(open)
        .filter((row) => row.explained)
        .map((row) => row.name)
    ).toEqual(['card_create']);
    const other = chatToolAnswersReducer(open, { type: 'explain', tool: 'card_update' });
    expect(
      chatToolAnswerRows(other)
        .filter((row) => row.explained)
        .map((row) => row.name)
    ).toEqual(['card_update']);
    expect(
      chatToolAnswersReducer(other, { type: 'explain', tool: 'card_update' }).explaining
    ).toBeNull();
  });

  it('Block a tool offers the chat’s tools no block covers yet, reading ones too, narrowed by the search', () => {
    const withTools = fold(
      loaded({
        chat: { allow: ['card_update'], deny: ['card_create'] },
        always: { allow: [], deny: [] },
        locked: [],
        tools: [
          {
            key: 'renkei-cards',
            label: 'Renkei cards',
            tools: [
              { name: 'card_create', label: 'Create a card' },
              { name: 'card_list', label: 'List cards', read: true },
              { name: 'card_update', label: 'Update a card' },
            ],
          },
          {
            key: 'jira',
            label: 'Jira',
            tools: [{ name: 'jira_search', label: 'Search', read: true }],
          },
        ],
      }),
      { type: 'picker-opened' }
    );
    expect(withTools.picker.open).toBe(true);
    expect(pickerGroups(withTools).groups).toEqual([
      {
        key: 'renkei-cards',
        label: 'Renkei cards',
        tools: [
          { name: 'card_list', label: 'List cards', read: true, selected: false },
          // Allowed here, but it can still be blocked.
          { name: 'card_update', label: 'Update a card', read: false, selected: false },
        ],
      },
      {
        key: 'jira',
        label: 'Jira',
        tools: [{ name: 'jira_search', label: 'Search', read: true, selected: false }],
      },
    ]);
    const narrowed = chatToolAnswersReducer(withTools, { type: 'picker-filter', filter: 'jira' });
    expect(pickerGroups(narrowed).groups.map((group) => group.key)).toEqual(['jira']);
    // A row uses the catalog's words for the tool.
    expect(chatToolAnswerRows(withTools).map((row) => row.label)).toEqual([
      'Create a card',
      'Update a card',
    ]);
  });

  it('lists the four decisions in one list, blocks first, each with its tag and glyph', () => {
    const rows = chatToolAnswerRows(fold(all));
    expect(rows.map((row) => [row.name, row.tag.text, row.tag.glyph, row.scope])).toEqual([
      ['card_create', 'Blocked here', 'ban', 'chat'],
      ['jira_delete_issue', 'Always blocked', 'hand', 'always'],
      ['card_update', 'Allowed here', 'check', 'chat'],
      ['outlook_create_draft', 'Always allowed', 'double-check', 'always'],
    ]);
    expect(chatToolAnswersCount(fold(all))).toBe('2 blocked · 2 allowed');
  });

  it('one row per tool, saying the decision that applies: a block beats an allow, here beats always', () => {
    const state = fold(
      loaded({
        chat: { allow: ['jira_create_issue'], deny: ['card_create'] },
        always: { allow: ['card_create'], deny: ['jira_create_issue'] },
        locked: [],
      })
    );
    expect(chatToolAnswerRows(state).map((row) => [row.name, row.decision])).toEqual([
      // Blocked here, though always allowed.
      ['card_create', 'blocked-here'],
      // Always blocked, though allowed here: the block wins.
      ['jira_create_issue', 'always-blocked'],
    ]);
  });

  it('an allowed tool the organization locks says it still asks', () => {
    const [row] = chatToolAnswerRows(
      fold(
        loaded({
          chat: { allow: [], deny: [] },
          always: { allow: ['outlook_send_mail'], deny: [] },
          locked: ['outlook_send_mail'],
        })
      )
    );
    expect([row.locked, row.tag.text, row.tag.glyph]).toEqual([true, 'Locked · asks', 'lock']);
  });

  it('groups the rows by kind of tool, so two short labels that read alike stay apart', () => {
    expect(
      chatToolAnswerGroups(fold(all)).map((group) => [
        group.label,
        group.rows.map((row) => row.name),
      ])
    ).toEqual([
      ['Card', ['card_create', 'card_update']],
      ['Jira', ['jira_delete_issue']],
      ['Outlook', ['outlook_create_draft']],
    ]);
  });

  it('one reset at a time: every Reset is off while one is on its way', () => {
    const state = fold(
      all,
      { type: 'reset-started', tool: 'card_create' },
      { type: 'reset-started', tool: 'card_update' }
    );
    expect(state.resetting).toBe('card_create');
    const rows = chatToolAnswerRows(state);
    expect(rows.find((row) => row.name === 'card_create')?.busy).toBe(true);
    expect(rows.every((row) => row.disabled)).toBe(true);
  });

  it('after a reset the server says what is left, and the next decision down shows', () => {
    const state = fold(
      loaded({
        chat: { allow: [], deny: ['card_create'] },
        always: { allow: ['card_create'], deny: [] },
        locked: [],
      }),
      { type: 'reset-started', tool: 'card_create' },
      {
        type: 'reset-succeeded',
        answers: {
          chat: { allow: [], deny: [] },
          always: { allow: ['card_create'], deny: [] },
          locked: [],
        },
      }
    );
    expect(chatToolAnswerRows(state).map((row) => [row.name, row.decision])).toEqual([
      ['card_create', 'always-allowed'],
    ]);
  });

  it('a refused reset keeps the rows and says why; the next press clears it', () => {
    const refused = fold(
      all,
      { type: 'reset-started', tool: 'card_create' },
      { type: 'reset-failed', error: 'Could not reach the server' }
    );
    expect(refused.error).toBe('Could not reach the server');
    expect(chatToolAnswerRows(refused)).toHaveLength(4);
    expect(
      chatToolAnswersReducer(refused, { type: 'reset-started', tool: 'card_create' }).error
    ).toBeNull();
  });

  it('the Block dialog: Save is off until a tool is picked, takes a scope, and closes once saved', () => {
    const open = fold(all, { type: 'picker-opened' });
    expect(blockSave(open)).toEqual({ disabled: true, label: 'Save' });
    const actions: ChatToolAnswersAction[] = [
      { type: 'picker-select', tool: 'card_list' },
      { type: 'picker-scope', scope: 'always' },
    ];
    const picked = actions.reduce(chatToolAnswersReducer, open);
    expect(picked.picker).toMatchObject({ open: true, selected: 'card_list', scope: 'always' });
    expect(blockSave(picked)).toEqual({ disabled: false, label: 'Save' });
    const saving = chatToolAnswersReducer(picked, { type: 'block-started', tool: 'card_list' });
    expect(blockSave(saving)).toEqual({ disabled: true, label: 'Saving…' });
    const saved = chatToolAnswersReducer(saving, {
      type: 'reset-succeeded',
      answers: {
        chat: { allow: [], deny: [] },
        always: { allow: [], deny: ['card_list'] },
        locked: [],
      },
    });
    expect(saved.picker.open).toBe(false);
    expect(chatToolAnswerRows(saved).map((row) => [row.name, row.decision])).toEqual([
      ['card_list', 'always-blocked'],
    ]);
    // A refused save keeps the dialog open with the pick.
    const refused = chatToolAnswersReducer(saving, { type: 'reset-failed', error: 'No' });
    expect(refused.picker).toMatchObject({ open: true, selected: 'card_list' });
  });

  it('closing the Block dialog forgets the search and the pick', () => {
    const actions: ChatToolAnswersAction[] = [
      { type: 'picker-opened' },
      { type: 'picker-filter', filter: 'card' },
      { type: 'picker-select', tool: 'card_list' },
      { type: 'picker-closed' },
    ];
    const closed = actions.reduce(chatToolAnswersReducer, fold(all));
    expect(closed.picker).toEqual({ open: false, filter: '', selected: null, scope: 'chat' });
  });
});
