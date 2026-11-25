import {
  chatToolAnswerGroups,
  chatToolAnswersCount,
  resetAllView,
  chatToolAnswerRows,
  chatToolAnswersReducer,
  initialChatToolAnswersState,
  showsChatToolAnswers,
  type ChatToolAnswersAction,
} from './chat-tool-answers.model';

const fold = (...actions: ChatToolAnswersAction[]) =>
  actions.reduce(chatToolAnswersReducer, initialChatToolAnswersState);

const decided = {
  type: 'loaded' as const,
  answers: { allow: ['jira_create_issue'], deny: ['chat_memory_remember'] },
};

describe('Decided in this chat', () => {
  it('shows nothing until loaded, and nothing when the chat has decided nothing', () => {
    expect(showsChatToolAnswers(fold())).toBe(false);
    expect(showsChatToolAnswers(fold({ type: 'loaded', answers: { allow: [], deny: [] } }))).toBe(
      false
    );
  });

  it('lists each decided tool, blocked ones first, and counts them in the heading', () => {
    const state = fold(decided);
    const rows = chatToolAnswerRows(state);
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ['chat_memory_remember', 'Blocked'],
      ['jira_create_issue', 'Allowed'],
    ]);
    expect(rows[0].label).not.toBe('');
    expect(chatToolAnswersCount(state)).toBe('1 blocked · 1 allowed');
    expect(
      chatToolAnswersCount(fold({ type: 'loaded', answers: { allow: [], deny: ['a', 'b'] } }))
    ).toBe('2 blocked');
  });

  it('Reset all is offered from two decisions up, and turns every undo off while it runs', () => {
    expect(resetAllView(fold(decided))).toEqual({ shown: true, disabled: false });
    expect(resetAllView(fold({ type: 'loaded', answers: { allow: [], deny: ['a'] } })).shown).toBe(
      false
    );
    const running = fold(decided, { type: 'reset-all-started' });
    expect(resetAllView(running).disabled).toBe(true);
    expect(chatToolAnswerRows(running).every((row) => row.busy && row.disabled)).toBe(true);
    const done = chatToolAnswersReducer(running, {
      type: 'reset-succeeded',
      answers: { allow: [], deny: [] },
    });
    expect(showsChatToolAnswers(done)).toBe(false);
  });

  it('one reset at a time: every Reset is off while it is on its way, the pressed one saying so', () => {
    const state = fold(
      decided,
      { type: 'reset-started', tool: 'chat_memory_remember' },
      { type: 'reset-started', tool: 'jira_create_issue' }
    );
    expect(state.resetting).toBe('chat_memory_remember');
    expect(chatToolAnswerRows(state).map((row) => [row.busy, row.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  it('a reset that went through takes the row away (the server says what is left)', () => {
    const state = fold(
      decided,
      { type: 'reset-started', tool: 'chat_memory_remember' },
      { type: 'reset-succeeded', answers: { allow: ['jira_create_issue'], deny: [] } }
    );
    expect(chatToolAnswerRows(state).map((row) => row.name)).toEqual(['jira_create_issue']);
  });

  it('a refused reset keeps the row and says why; the next press clears it', () => {
    const refused = fold(
      decided,
      { type: 'reset-started', tool: 'chat_memory_remember' },
      { type: 'reset-failed', error: 'Could not reach the server' }
    );
    expect(refused.error).toBe('Could not reach the server');
    expect(chatToolAnswerRows(refused)).toHaveLength(2);
    expect(
      chatToolAnswersReducer(refused, { type: 'reset-started', tool: 'chat_memory_remember' }).error
    ).toBeNull();
  });

  it('reads whatever the route answered, leaving out what is not a name', () => {
    const state = fold({ type: 'loaded', answers: { allow: [3], deny: ['b', 'a'] } });
    expect(state.answers).toEqual({ allow: [], deny: ['a', 'b'] });
  });

  it('groups the rows by kind of tool, so two short labels that read alike stay apart', () => {
    const state = fold({
      type: 'loaded',
      answers: {
        allow: ['card_update'],
        deny: ['card_create', 'agent_create', 'github_merge_pull_request'],
      },
    });
    expect(
      chatToolAnswerGroups(state).map((group) => [group.label, group.rows.map((row) => row.name)])
    ).toEqual([
      ['Agent', ['agent_create']],
      ['Card', ['card_create', 'card_update']],
      ['GitHub', ['github_merge_pull_request']],
    ]);
  });
});
