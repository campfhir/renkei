import {
  connectorLabel,
  effectiveTools,
  explanation,
  footer,
  initialToolsDialogState,
  listView,
  missingLocked,
  needsConnectors,
  saveDefaultConnectors,
  toggledTools,
  toolsDialogReducer,
  triggerCount,
  type ConnectorsAnswer,
  type ToolsDialogAction,
  type ToolsDialogProps,
  type ToolsDialogState,
} from './tools-dialog.model';

const option = (key: string, count = 3) => ({ key, count, core: false });

const answer: ConnectorsAnswer = {
  connectors: [option('agents'), option('cards'), option('knowledge'), option('sandbox')],
  core: ['agents', 'cards', 'knowledge', 'sandbox'],
  codeDefault: ['sandbox'],
  userDefault: { connectors: ['cards'] },
  userCodeDefault: null,
};

const chatProps = (over: Partial<ToolsDialogProps> = {}): ToolsDialogProps => ({
  selected: null,
  context: 'chat',
  kind: 'chat',
  projectDefault: null,
  locked: [],
  ...over,
});

function fold(...actions: ToolsDialogAction[]): ToolsDialogState {
  return actions.reduce(toolsDialogReducer, initialToolsDialogState());
}

const loaded = (over: Partial<ConnectorsAnswer> = {}) =>
  fold({ type: 'connectorsLoaded', answer: { ...answer, ...over } });

const checked = (state: ToolsDialogState, props: ToolsDialogProps) =>
  [...effectiveTools(state, props)].sort();

describe('which boxes a chat starts with', () => {
  test('a new chat in a project starts from the project’s toolset, not the person’s default or the core set', () => {
    const props = chatProps({ projectDefault: ['agents'] });
    expect(checked(loaded(), props)).toEqual(['agents']);
    expect(explanation(props)).toContain('Starts from this project’s toolset');
  });

  test('outside a project the person’s own default applies, else the core set', () => {
    expect(checked(loaded(), chatProps())).toEqual(['cards']);
    expect(checked(loaded({ userDefault: null }), chatProps())).toEqual(answer.core);
  });

  test('what the chat has chosen wins over every default', () => {
    const props = chatProps({ selected: ['sandbox'], projectDefault: ['agents'] });
    expect(checked(loaded(), props)).toEqual(['sandbox']);
  });

  test('a code chat falls back to the person’s code default, else the code default', () => {
    const code = chatProps({ kind: 'code' });
    expect(checked(loaded(), code)).toEqual(['sandbox']);
    expect(checked(loaded({ userCodeDefault: { connectors: ['agents'] } }), code)).toEqual([
      'agents',
    ]);
  });

  test('a connector the project requires is always checked, whatever is chosen', () => {
    const props = chatProps({ kind: 'code', selected: ['cards'], locked: ['github'] });
    expect(checked(loaded(), props)).toEqual(['cards', 'github']);
  });
});

describe('ticking a box', () => {
  test('pins the whole list shown on the chat, sorted', () => {
    const props = chatProps({ projectDefault: ['sandbox', 'agents'] });
    expect(toggledTools(loaded(), props, 'cards', true)).toEqual(['agents', 'cards', 'sandbox']);
    expect(toggledTools(loaded(), props, 'sandbox', false)).toEqual(['agents']);
  });

  test('Save as my default sends what shows checked, sorted', () => {
    const props = chatProps({ selected: ['sandbox', 'agents'], locked: ['github'] });
    expect(saveDefaultConnectors(loaded(), props)).toEqual(['agents', 'github', 'sandbox']);
  });
});

describe('the catalog', () => {
  test('is fetched once the dialog opens, and not again once it has answered', () => {
    expect(needsConnectors(initialToolsDialogState(), false)).toBe(false);
    expect(needsConnectors(initialToolsDialogState(), true)).toBe(true);
    expect(needsConnectors(loaded(), true)).toBe(false);
  });

  test('shows loading, then the rows; a failed load reads as nothing connected', () => {
    expect(listView(initialToolsDialogState())).toEqual({ kind: 'loading' });
    expect(listView(loaded()).kind).toBe('rows');
    expect(listView(fold({ type: 'connectorsFailed' }))).toEqual({ kind: 'nothing-connected' });
  });

  test('a required connector the person has not linked is listed as missing', () => {
    const props = chatProps({ kind: 'code', locked: ['agents', 'bitbucket'] });
    expect(missingLocked(initialToolsDialogState(), props)).toEqual([]);
    expect(missingLocked(loaded(), props)).toEqual(['bitbucket']);
  });
});

describe('searching', () => {
  test('narrows the list by name as you type, any case', () => {
    const state = toolsDialogReducer(loaded(), { type: 'filterChanged', filter: 'SAND' });
    const view = listView(state);
    expect(view.kind === 'rows' && view.rows.map((row) => row.key)).toEqual(['sandbox']);
  });

  test('matches the catalog label as well as the key', () => {
    expect(connectorLabel('sandbox')).toBe('Renkei sandbox');
    expect(connectorLabel('unknown-key')).toBe('unknown-key');
    const state = toolsDialogReducer(loaded(), { type: 'filterChanged', filter: 'renkei s' });
    const view = listView(state);
    expect(view.kind === 'rows' && view.rows.map((row) => row.key)).toContain('sandbox');
  });

  test('says nothing matches, and emptied shows everything again', () => {
    let state = toolsDialogReducer(loaded(), { type: 'filterChanged', filter: '  zzz ' });
    expect(listView(state)).toEqual({ kind: 'no-match', filter: 'zzz' });
    state = toolsDialogReducer(state, { type: 'filterChanged', filter: '' });
    const view = listView(state);
    expect(view.kind === 'rows' && view.rows).toHaveLength(4);
  });

  test('closing the dialog empties the search and the saved word', () => {
    const state = fold(
      { type: 'connectorsLoaded', answer },
      { type: 'filterChanged', filter: 'sand' },
      { type: 'saveDefaultStarted' },
      { type: 'saveDefaultAnswered', kind: 'chat', ok: true, connectors: ['cards'] },
      { type: 'closed' }
    );
    expect(state.filter).toBe('');
    expect(state.savedWord).toBeNull();
    expect(state.options).toHaveLength(4);
  });
});

describe('the footer', () => {
  test('a chat offers Save as my default; Clear only when one is saved; Reset once something is chosen', () => {
    const none = footer(loaded({ userDefault: null }), chatProps());
    expect(none.save).toEqual({ label: 'Save as my default', disabled: false });
    expect(none.clear).toBeNull();
    expect(none.reset).toBe(false);
    const saved = footer(loaded(), chatProps({ selected: ['cards'] }));
    expect(saved.clear).toEqual({ disabled: false });
    expect(saved.reset).toBe(true);
  });

  test('a code chat names the code-projects default', () => {
    expect(footer(loaded(), chatProps({ kind: 'code' })).save?.label).toBe(
      'Save as my default for code projects'
    );
  });

  test('a project’s own dialog hides the personal default and says toggles save at once', () => {
    const props = chatProps({ context: 'project' });
    const foot = footer(loaded(), props);
    expect(foot.save).toBeNull();
    expect(foot.clear).toBeNull();
    expect(foot.projectNote).toBe(true);
    expect(explanation(props)).toBe(
      'Connectors chats in this project start with, unless a chat picks its own.'
    );
    // The new code project form offers it there all the same.
    expect(footer(loaded(), { ...props, saveDefault: true }).save).not.toBeNull();
  });

  test('nothing to save while the catalog is loading or empty', () => {
    expect(footer(initialToolsDialogState(), chatProps()).save).toBeNull();
    expect(footer(fold({ type: 'connectorsFailed' }), chatProps()).save).toBeNull();
  });

  test('the trigger counts what the chat has pinned, nothing when it follows a default', () => {
    expect(triggerCount(chatProps())).toBeNull();
    expect(triggerCount(chatProps({ selected: ['a', 'b'] }))).toBe(2);
  });
});

describe('saving and clearing the personal default', () => {
  test('a save in flight disables the buttons and reads Saving…', () => {
    const state = toolsDialogReducer(loaded(), { type: 'saveDefaultStarted' });
    expect(footer(state, chatProps()).save).toEqual({ label: 'Saving…', disabled: true });
    expect(footer(state, chatProps()).clear).toEqual({ disabled: true });
  });

  test('a saved default becomes the fallback and says so', () => {
    const state = fold(
      { type: 'connectorsLoaded', answer: { ...answer, userDefault: null } },
      { type: 'saveDefaultStarted' },
      { type: 'saveDefaultAnswered', kind: 'chat', ok: true, connectors: ['sandbox'] }
    );
    expect(state.savedWord).toBe('Saved as your default.');
    expect(checked(state, chatProps())).toEqual(['sandbox']);
  });

  test('a code save writes the code default, not the chat one', () => {
    const state = fold(
      { type: 'connectorsLoaded', answer },
      { type: 'saveDefaultAnswered', kind: 'code', ok: true, connectors: ['agents'] }
    );
    expect(state.userCodeDefault).toEqual(['agents']);
    expect(state.userDefault).toEqual(['cards']);
  });

  test('a refused save leaves the default as it was and says nothing', () => {
    const state = fold(
      { type: 'connectorsLoaded', answer },
      { type: 'saveDefaultStarted' },
      { type: 'saveDefaultAnswered', kind: 'chat', ok: false, connectors: null }
    );
    expect(state.userDefault).toEqual(['cards']);
    expect(state.savedWord).toBeNull();
    expect(state.savingDefault).toBe(false);
  });

  test('clearing drops back to the core set and says so', () => {
    const state = fold(
      { type: 'connectorsLoaded', answer },
      { type: 'clearDefaultStarted' },
      { type: 'clearDefaultAnswered', kind: 'chat' }
    );
    expect(state.savedWord).toBe('Your default is cleared.');
    expect(checked(state, chatProps())).toEqual(answer.core);
    expect(footer(state, chatProps()).clear).toBeNull();
  });
});
