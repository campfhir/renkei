import {
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

  it('lists each decided tool, blocked ones first, each with Reset', () => {
    const rows = chatToolAnswerRows(fold(decided));
    expect(rows.map((row) => [row.name, row.decided, row.reset.label])).toEqual([
      ['chat_memory_remember', 'Blocked in this chat', 'Reset'],
      ['jira_create_issue', 'Allowed in this chat', 'Reset'],
    ]);
    expect(rows[0].label).not.toBe('');
  });

  it('one reset at a time: every Reset is off while it is on its way, the pressed one saying so', () => {
    const state = fold(
      decided,
      { type: 'reset-started', tool: 'chat_memory_remember' },
      { type: 'reset-started', tool: 'jira_create_issue' }
    );
    expect(state.resetting).toBe('chat_memory_remember');
    expect(chatToolAnswerRows(state).map((row) => row.reset)).toEqual([
      { label: 'Resetting…', disabled: true },
      { label: 'Reset', disabled: true },
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
});
