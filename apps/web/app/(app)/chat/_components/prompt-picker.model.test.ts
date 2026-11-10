import {
  GROUP_LIMIT,
  activePrompt,
  emptyMessage,
  initialPicker,
  pickerGroups,
  pickerLibraries,
  pickerReducer,
  showLibraryFilter,
  visibleRows,
  type PickerAction,
  type PickerPrompt,
  type PickerState,
} from './prompt-picker.model';

function prompt(
  id: string,
  title: string,
  library: { id: string; name: string; scope?: 'any' | 'code' },
  body = ''
): PickerPrompt {
  return {
    id,
    title,
    body,
    libraryId: library.id,
    libraryName: library.name,
    libraryScope: library.scope ?? 'any',
  };
}

const run = (prompts: PickerPrompt[] | null, ...actions: PickerAction[]): PickerState =>
  actions.reduce(
    pickerReducer,
    prompts ? pickerReducer(initialPicker(), { type: 'loaded', prompts }) : initialPicker()
  );

const dev = { id: 'l-dev', name: 'Development', scope: 'code' as const };
const writing = { id: 'l-wr', name: 'Writing' };
const many = (library: typeof dev | typeof writing, n: number) =>
  Array.from({ length: n }, (_, i) =>
    prompt(`${library.id}-${i}`, `${library.name} ${i}`, library)
  );
const titles = (state: PickerState) => visibleRows(state).map((row) => row.title);

describe('before the prompts load', () => {
  it('shows nothing and no empty message', () => {
    const state = run(null);
    expect(visibleRows(state)).toEqual([]);
    expect(emptyMessage(state)).toBeNull();
  });

  it('a failed load leaves an empty list and the reason', () => {
    const state = run(null, { type: 'failed', error: 'offline' });
    expect(state.error).toBe('offline');
    expect(emptyMessage(state)).toBe('No prompts yet — create a library first.');
  });
});

describe('a list of prompts', () => {
  it('is grouped under its libraries, libraries in name order', () => {
    const state = run([prompt('1', 'Draft', writing), prompt('2', 'Review', dev)]);
    expect(pickerGroups(state).map((g) => g.libraryName)).toEqual(['Development', 'Writing']);
  });

  it('marks a group as code-scoped', () => {
    const state = run([prompt('1', 'Review', dev)]);
    expect(pickerGroups(state)[0]?.libraryScope).toBe('code');
  });

  it('keeps the author’s order inside a library', () => {
    const state = run([prompt('1', 'Zebra', dev), prompt('2', 'Apple', dev)]);
    expect(titles(state)).toEqual(['Zebra', 'Apple']);
  });
});

describe('a library with many prompts', () => {
  const prompts = [...many(dev, 20), ...many(writing, 3)];

  it('folds to a few rows and says how many are hidden', () => {
    const group = pickerGroups(run(prompts))[0];
    expect(group).toMatchObject({
      libraryName: 'Development',
      total: 20,
      hidden: 20 - GROUP_LIMIT,
    });
    expect(group?.rows).toHaveLength(GROUP_LIMIT);
  });

  it('opens in full when asked, and folds again when asked again', () => {
    const open = run(prompts, { type: 'groupToggled', libraryId: dev.id });
    expect(pickerGroups(open)[0]?.rows).toHaveLength(20);
    const closed = pickerReducer(open, { type: 'groupToggled', libraryId: dev.id });
    expect(pickerGroups(closed)[0]?.rows).toHaveLength(GROUP_LIMIT);
  });

  it('shows all of one library once the list is narrowed to it', () => {
    const state = run(prompts, { type: 'libraryChosen', libraryId: dev.id });
    expect(visibleRows(state)).toHaveLength(20);
    expect(pickerGroups(state)).toHaveLength(1);
  });

  it('offers a library filter with counts only when there is more than one library', () => {
    expect(showLibraryFilter(run(prompts))).toBe(true);
    expect(pickerLibraries(run(prompts))).toEqual([
      { id: dev.id, name: 'Development', count: 20 },
      { id: writing.id, name: 'Writing', count: 3 },
    ]);
    expect(showLibraryFilter(run(many(dev, 5)))).toBe(false);
  });
});

describe('searching', () => {
  const prompts = [
    prompt('1', 'Explain a stack trace', dev, 'Walk through the error'),
    prompt('2', 'Write a release note', writing, 'Summarise the stack of changes'),
    prompt('3', 'Review a pull request', dev, 'Look for bugs'),
  ];

  it('matches title, body and library name, every word needed', () => {
    expect(titles(run(prompts, { type: 'queryChanged', query: 'stack' }))).toEqual([
      'Explain a stack trace',
      'Write a release note',
    ]);
    expect(titles(run(prompts, { type: 'queryChanged', query: 'writing release' }))).toEqual([
      'Write a release note',
    ]);
    expect(titles(run(prompts, { type: 'queryChanged', query: 'nothing here' }))).toEqual([]);
  });

  it('puts a title match above a body-only match within a library', () => {
    const state = run(
      [prompt('1', 'Notes', dev, 'about the deploy'), prompt('2', 'Deploy checklist', dev)],
      { type: 'queryChanged', query: 'deploy' }
    );
    expect(titles(state)).toEqual(['Deploy checklist', 'Notes']);
  });

  it('is not case sensitive', () => {
    expect(titles(run(prompts, { type: 'queryChanged', query: 'PULL' }))).toEqual([
      'Review a pull request',
    ]);
  });

  it('says there are no matches, not that there are no prompts', () => {
    expect(emptyMessage(run(prompts, { type: 'queryChanged', query: 'zzz' }))).toBe('No matches.');
  });

  it('works inside a narrowed library', () => {
    const state = run(
      prompts,
      { type: 'libraryChosen', libraryId: dev.id },
      { type: 'queryChanged', query: 'stack' }
    );
    expect(titles(state)).toEqual(['Explain a stack trace']);
  });
});

describe('the keyboard', () => {
  const prompts = [prompt('1', 'A', dev), prompt('2', 'B', dev), prompt('3', 'C', writing)];

  it('starts on the first row, and Enter takes it', () => {
    expect(activePrompt(run(prompts))?.id).toBe('1');
  });

  it('walks down and up through the groups as one list, stopping at the ends', () => {
    const down = run(prompts, { type: 'moved', by: 1 }, { type: 'moved', by: 1 });
    expect(activePrompt(down)?.title).toBe('C');
    expect(activePrompt(pickerReducer(down, { type: 'moved', by: 1 }))?.title).toBe('C');
    expect(activePrompt(pickerReducer(down, { type: 'moved', by: -1 }))?.title).toBe('B');
    expect(activePrompt(run(prompts, { type: 'moved', by: -1 }))?.title).toBe('A');
  });

  it('jumps to the first and last row', () => {
    expect(activePrompt(run(prompts, { type: 'movedTo', to: 'last' }))?.title).toBe('C');
    expect(
      activePrompt(run(prompts, { type: 'movedTo', to: 'last' }, { type: 'movedTo', to: 'first' }))
        ?.title
    ).toBe('A');
  });

  it('returns to the top when the search changes', () => {
    const state = run(
      prompts,
      { type: 'movedTo', to: 'last' },
      { type: 'queryChanged', query: 'a' }
    );
    expect(state.active).toBe(0);
  });

  it('does nothing to move through an empty list, and has no row to take', () => {
    const state = run(prompts, { type: 'queryChanged', query: 'zzz' }, { type: 'moved', by: 1 });
    expect(activePrompt(state)).toBeNull();
  });

  it('keeps the row under the pointer as the active one', () => {
    expect(activePrompt(run(prompts, { type: 'pointed', index: 2 }))?.title).toBe('C');
  });

  it('stays on a real row when folding a group removes the one it was on', () => {
    const big = many(dev, 12);
    const state = run(
      big,
      { type: 'groupToggled', libraryId: dev.id },
      { type: 'movedTo', to: 'last' },
      { type: 'groupToggled', libraryId: dev.id }
    );
    expect(activePrompt(state)?.title).toBe(`Development ${GROUP_LIMIT - 1}`);
  });
});
