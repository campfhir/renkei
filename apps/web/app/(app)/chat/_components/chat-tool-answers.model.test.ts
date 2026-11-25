import {
  blockSave,
  chatToolAnswerGroups,
  chatToolAnswerRows,
  chatToolAnswersCount,
  chatToolAnswersReducer,
  initialChatToolAnswersState,
  pickerGroups,
  setOptions,
  showsChatToolAnswers,
  type ChatToolAnswersAction,
} from './chat-tool-answers.model';

const fold = (...actions: ChatToolAnswersAction[]) =>
  actions.reduce(chatToolAnswersReducer, initialChatToolAnswersState);

const TOOLS = [
  {
    key: 'renkei-cards',
    label: 'Renkei cards',
    tools: [
      { name: 'card_create', label: 'Put a card on your feed' },
      { name: 'card_list', label: 'List cards', read: true },
      { name: 'card_update', label: 'Update a card' },
    ],
  },
  {
    key: 'outlook',
    label: 'Outlook',
    tools: [
      { name: 'outlook_send_mail', label: 'Send mail' },
      { name: 'outlook_list_mail', label: 'List mail', read: true },
    ],
  },
];

const lists = (overrides: Record<string, unknown> = {}) => ({
  kind: 'chat',
  chat: { allow: [], deny: [], ask: [] },
  project: null,
  always: { allow: [], deny: [] },
  locked: [],
  tools: TOOLS,
  ...overrides,
});
const loaded = (overrides: Record<string, unknown> = {}): ChatToolAnswersAction => ({
  type: 'loaded',
  answers: lists(overrides),
});

describe('Permissions', () => {
  it('shows once loaded, listing nothing when nothing is decided (act tools ask, read tools run)', () => {
    expect(showsChatToolAnswers(fold())).toBe(false);
    const none = fold(loaded());
    expect(showsChatToolAnswers(none)).toBe(true);
    expect(chatToolAnswerRows(none)).toEqual([]);
    expect(chatToolAnswersCount(none)).toBe('');
  });

  it('says the decision that applies and which layer made it: blocks first, then asks, then allowed', () => {
    const state = fold(
      loaded({
        kind: 'project',
        chat: { allow: ['card_update'], deny: ['card_create'], ask: ['card_list'] },
        project: { name: 'Sprint', allow: ['outlook_send_mail'], ask: ['outlook_list_mail'] },
        always: { allow: ['agent_run_now'], deny: ['jira_delete_issue'] },
      })
    );
    expect(chatToolAnswerRows(state).map((row) => [row.name, row.tag.text, row.scope])).toEqual([
      ['card_create', 'Blocked here', 'chat'],
      ['jira_delete_issue', 'Always blocked', 'always'],
      ['card_list', 'Asks here', 'chat'],
      ['outlook_list_mail', 'Project asks', null],
      ['card_update', 'Allowed here', 'chat'],
      ['outlook_send_mail', 'Project allows', null],
      ['agent_run_now', 'Always allowed', 'always'],
    ]);
    expect(chatToolAnswersCount(state)).toBe('2 blocked · 2 ask · 3 allowed');
  });

  it('a tag’s tip says what it means here; "always" names the kind of chat it reaches', () => {
    const [row] = chatToolAnswerRows(
      fold(loaded({ kind: 'code', always: { allow: [], deny: ['card_create'] } }))
    );
    expect(row.tag.meaning).toBe(
      'Refused in every code project chat: the model can never use it there.'
    );
    const [project] = chatToolAnswerRows(
      fold(
        loaded({ kind: 'project', project: { name: 'Sprint', allow: ['card_create'], ask: [] } })
      )
    );
    expect(project.tag.meaning).toMatch(/^“Sprint” lets it run without asking in its chats/);
  });

  it('an allow on a tool the organization locks shows that it asks, with nothing to reset here', () => {
    const [row] = chatToolAnswerRows(
      fold(
        loaded({
          always: { allow: ['outlook_send_mail'], deny: [] },
          locked: ['outlook_send_mail'],
        })
      )
    );
    expect([row.tag.text, row.tag.tone, row.scope]).toEqual(['Locked · asks', 'asks', null]);
  });

  it('pressing a tag pins its tip; another tag moves it; pressing again lets go', () => {
    const state = fold(
      loaded({ chat: { allow: ['card_update'], deny: ['card_create'], ask: [] } }),
      {
        type: 'explain',
        tool: 'card_create',
      }
    );
    expect(
      chatToolAnswerRows(state)
        .filter((row) => row.explained)
        .map((row) => row.name)
    ).toEqual(['card_create']);
    const moved = chatToolAnswersReducer(state, { type: 'explain', tool: 'card_update' });
    expect(moved.explaining).toBe('card_update');
    expect(
      chatToolAnswersReducer(moved, { type: 'explain', tool: 'card_update' }).explaining
    ).toBeNull();
  });

  it('groups rows by kind of tool, so two short labels that read alike stay apart', () => {
    const state = fold(
      loaded({ chat: { allow: [], deny: ['card_create', 'outlook_send_mail'], ask: [] } })
    );
    expect(chatToolAnswerGroups(state).map((group) => group.label)).toEqual(['Card', 'Outlook']);
  });

  it('a reset that went through shows the next decision down', () => {
    const state = fold(
      loaded({
        chat: { allow: [], deny: ['card_create'], ask: [] },
        always: { allow: ['card_create'], deny: [] },
      }),
      { type: 'reset-started', tool: 'card_create' },
      {
        type: 'reset-succeeded',
        answers: lists({ always: { allow: ['card_create'], deny: [] } }),
      }
    );
    expect(chatToolAnswerRows(state).map((row) => row.tag.text)).toEqual(['Always allowed']);
  });
});

describe('Set a tool', () => {
  const pick = (tool: string, overrides: Record<string, unknown> = {}) =>
    fold(loaded(overrides), { type: 'picker-opened' }, { type: 'picker-select', tool });

  it('offers this chat’s Allow and Block for a tool that acts, and Ask and Block for one that reads', () => {
    expect(setOptions(pick('card_create')).chat.map((option) => option.label)).toEqual([
      'Allow',
      'Block',
    ]);
    expect(setOptions(pick('card_create')).always.map((option) => option.label)).toEqual([
      'Always allow',
      'Always block',
    ]);
    expect(setOptions(pick('card_list')).chat.map((option) => option.label)).toEqual([
      'Ask',
      'Block',
    ]);
    expect(setOptions(pick('card_list')).always.map((option) => option.label)).toEqual([
      'Always block',
    ]);
  });

  it('never offers to allow a tool the organization locks', () => {
    expect(setOptions(pick('outlook_send_mail', { locked: ['outlook_send_mail'] }))).toMatchObject({
      chat: [{ label: 'Block' }],
      always: [{ label: 'Always block' }],
    });
  });

  it('Save is off until a tool and a choice are picked; a new tool forgets the old choice; saved closes it', () => {
    const open = fold(loaded(), { type: 'picker-opened' });
    expect(blockSave(open).disabled).toBe(true);
    const actions: ChatToolAnswersAction[] = [
      { type: 'picker-select', tool: 'card_create' },
      { type: 'picker-choice', scope: 'always', rule: 'allow' },
    ];
    const picked = actions.reduce(chatToolAnswersReducer, open);
    expect(blockSave(picked)).toEqual({ disabled: false, label: 'Save' });
    expect(setOptions(picked).always.find((option) => option.chosen)?.label).toBe('Always allow');
    expect(
      chatToolAnswersReducer(picked, { type: 'picker-select', tool: 'card_list' }).picker.choice
    ).toBeNull();
    const saving = chatToolAnswersReducer(picked, { type: 'block-started', tool: 'card_create' });
    expect(blockSave(saving)).toEqual({ disabled: true, label: 'Saving…' });
    const saved = chatToolAnswersReducer(saving, {
      type: 'reset-succeeded',
      answers: lists({ always: { allow: ['card_create'], deny: [] } }),
    });
    expect(saved.picker.open).toBe(false);
    expect(chatToolAnswerRows(saved).map((row) => row.tag.text)).toEqual(['Always allowed']);
    const refused = chatToolAnswersReducer(saving, { type: 'reset-failed', error: 'No' });
    expect(refused.picker).toMatchObject({ open: true, selected: 'card_create' });
  });

  it('lists the chat’s tools, narrowed by name or connector; closing forgets the search', () => {
    const state = fold(
      loaded(),
      { type: 'picker-opened' },
      { type: 'picker-filter', filter: 'outlook' }
    );
    expect(pickerGroups(state).groups.map((group) => group.key)).toEqual(['outlook']);
    expect(chatToolAnswersReducer(state, { type: 'picker-closed' }).picker.filter).toBe('');
  });
});
