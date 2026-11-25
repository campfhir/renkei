import {
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
  it('shows nothing until loaded, and nothing when no tool has a decision (they all ask)', () => {
    expect(showsChatToolAnswers(fold())).toBe(false);
    expect(
      showsChatToolAnswers(
        fold(loaded({ chat: { allow: [], deny: [] }, always: { allow: [], deny: [] }, locked: [] }))
      )
    ).toBe(false);
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
});
