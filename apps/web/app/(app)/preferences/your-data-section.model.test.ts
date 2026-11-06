import type { ImportPreview } from '@/lib/data-portability/types';
import {
  IMPORT_MAX_FILE_BYTES,
  canImport,
  canPreview,
  fileProblem,
  importLabel,
  importQuery,
  importedFromAnswer,
  initYourData,
  outcomeWords,
  previewLabel,
  previewQuery,
  previewFromAnswer,
  previewWords,
  refusalWords,
  showsPreview,
  yourDataReducer,
  type YourDataAction,
  type YourDataState,
} from './your-data-section.model';

const from = (state: YourDataState, ...actions: YourDataAction[]): YourDataState =>
  actions.reduce(yourDataReducer, state);
const run = (...actions: YourDataAction[]): YourDataState => from(initYourData(), ...actions);

const preview = (more: Partial<ImportPreview> = {}): ImportPreview => ({
  sources: ['ChatGPT'],
  memories: 12,
  chats: 3,
  messages: 40,
  sampleMemories: ['Has two cats'],
  sampleChats: [{ title: 'Trip', messages: 4 }],
  notes: [],
  ...more,
});

const chose = { type: 'fileChosen', name: 'export.zip', size: 2_000 } as const;
const outcome = {
  memoriesAdded: 12,
  memoriesNoRoom: 0,
  chatsAdded: 3,
  messagesAdded: 40,
  stopped: null,
};

describe('choosing what to import', () => {
  it('cannot preview before a file is chosen or text is pasted', () => {
    expect(canPreview(initYourData())).toBe(false);
    expect(canPreview(run(chose))).toBe(true);
    expect(
      canPreview(run({ type: 'inputChosen', input: 'paste' }, { type: 'pasted', text: '  ' }))
    ).toBe(false);
    expect(
      canPreview(run({ type: 'inputChosen', input: 'paste' }, { type: 'pasted', text: '- cats' }))
    ).toBe(true);
  });

  it('refuses an empty file and one over the limit before uploading', () => {
    const empty = run({ type: 'fileChosen', name: 'a.json', size: 0 });
    expect(fileProblem(empty)).toBe('That file is empty.');
    expect(canPreview(empty)).toBe(false);
    const huge = run({ type: 'fileChosen', name: 'a.zip', size: IMPORT_MAX_FILE_BYTES + 1 });
    expect(fileProblem(huge)).toBe('That file is larger than 100 MB.');
    expect(canPreview(huge)).toBe(false);
  });

  it('a file chosen while the paste box is showing does not count, and the reverse', () => {
    const state = run(chose, { type: 'inputChosen', input: 'paste' });
    expect(canPreview(state)).toBe(false);
    expect(canPreview(yourDataReducer(state, { type: 'inputChosen', input: 'file' }))).toBe(true);
  });

  it('a new file, new text or another input clears a preview already shown', () => {
    const shown = run(chose, { type: 'previewSent' }, { type: 'previewed', preview: preview() });
    const changes: YourDataAction[] = [
      { type: 'fileChosen', name: 'other.json', size: 10 },
      { type: 'fileCleared' },
      { type: 'pasted', text: 'x' },
      { type: 'inputChosen', input: 'paste' },
    ];
    for (const action of changes) {
      const next = yourDataReducer(shown, action);
      expect(next.preview).toBeNull();
      expect(next.phase).toBe('idle');
      expect(canImport(next)).toBe(false);
    }
  });
});

describe('the preview', () => {
  it('names the file it uploads, or calls pasted text Markdown', () => {
    expect(previewQuery(run(chose))).toBe('mode=preview&name=export.zip');
    expect(
      previewQuery(run({ type: 'inputChosen', input: 'paste' }, { type: 'pasted', text: '- x' }))
    ).toBe('mode=preview&name=pasted.md');
  });

  it('says Reading… and allows nothing else while it is out', () => {
    const state = run(chose, { type: 'previewSent' });
    expect(previewLabel(state)).toBe('Reading…');
    expect(canPreview(state)).toBe(false);
    expect(canImport(state)).toBe(false);
  });

  it('says what was found, from where', () => {
    expect(previewWords(preview())).toBe(
      'Found 12 memories and 3 chats (40 messages) from ChatGPT.'
    );
    expect(
      previewWords(preview({ chats: 0, messages: 0, memories: 1, sources: ['Claude', 'Markdown'] }))
    ).toBe('Found 1 memory from Claude and Markdown.');
    expect(previewWords(preview({ memories: 0, chats: 1, messages: 1, sources: [] }))).toBe(
      'Found 1 chat (1 message).'
    );
  });

  it('offers only what was found: no memories found leaves memories unchosen', () => {
    const state = run(
      chose,
      { type: 'previewSent' },
      { type: 'previewed', preview: preview({ memories: 0 }) }
    );
    expect(state.memories).toBe(false);
    expect(state.chats).toBe(true);
  });

  it('a refused preview shows why and can be tried again', () => {
    const state = run(
      chose,
      { type: 'previewSent' },
      { type: 'failed', problem: 'That zip could not be opened.' }
    );
    expect(state.problem).toBe('That zip could not be opened.');
    expect(canPreview(state)).toBe(true);
  });
});

describe('importing', () => {
  const previewed = (more: Partial<ImportPreview> = {}) =>
    run(chose, { type: 'previewSent' }, { type: 'previewed', preview: preview(more) });

  it('is allowed once previewed with something chosen, and not with nothing', () => {
    expect(canImport(run(chose))).toBe(false);
    expect(canImport(previewed())).toBe(true);
    const nothing = from(
      previewed(),
      { type: 'toggled', option: 'memories' },
      { type: 'toggled', option: 'chats' }
    );
    expect(canImport(nothing)).toBe(false);
  });

  it('asks for memories and chats, archived by default', () => {
    expect(importQuery(previewed())).toBe(
      'mode=import&name=export.zip&memories=1&chats=1&archive=1'
    );
  });

  it('asks only for what is chosen, and keeps chats out of the archive when asked', () => {
    const state = from(
      previewed(),
      { type: 'toggled', option: 'memories' },
      { type: 'toggled', option: 'archiveChats' }
    );
    expect(importQuery(state)).toBe('mode=import&name=export.zip&chats=1');
  });

  it('never asks for what was not found, even when chosen', () => {
    const state = run(
      chose,
      { type: 'previewSent' },
      { type: 'previewed', preview: preview({ chats: 0 }) }
    );
    const forced = yourDataReducer(state, { type: 'toggled', option: 'chats' });
    expect(importQuery(forced)).toBe('mode=import&name=export.zip&memories=1');
  });

  it('says Importing… and allows nothing else while it runs', () => {
    const state = yourDataReducer(previewed(), { type: 'importSent' });
    expect(importLabel(state)).toBe('Importing…');
    expect(canImport(state)).toBe(false);
    expect(canPreview(state)).toBe(false);
  });

  it('says what it imported, and allows nothing more until started over', () => {
    const state = from(
      previewed(),
      { type: 'importSent' },
      { type: 'imported', outcome, notes: [] }
    );
    expect(outcomeWords(state.outcome!)).toEqual(['Imported 12 memories and 3 chats.']);
    expect(canPreview(state)).toBe(false);
    expect(canImport(state)).toBe(false);
    const fresh = yourDataReducer(state, { type: 'startedOver' });
    expect(fresh).toEqual(initYourData());
  });

  it('says how many memories did not fit, and when the key stopped it', () => {
    expect(
      outcomeWords({
        ...outcome,
        memoriesAdded: 2,
        memoriesNoRoom: 10,
        chatsAdded: 0,
        stopped: 'chat-key',
      })
    ).toEqual([
      'Imported 2 memories.',
      '10 memories did not fit: your memory is full. Forget some on the Memory page and import again.',
      'The import stopped early: your encryption key was not available. Sign in again and retry.',
    ]);
    expect(outcomeWords({ ...outcome, memoriesAdded: 0, chatsAdded: 0 })).toEqual([
      'Nothing was imported.',
    ]);
  });
});

describe('refusals', () => {
  it('shows the server’s words, or a plain fallback', () => {
    expect(refusalWords({ error: 'That file is larger than 100 MB.' })).toBe(
      'That file is larger than 100 MB.'
    );
    expect(refusalWords(null)).toBe('Could not import that.');
    expect(refusalWords({ error: '' })).toBe('Could not import that.');
  });
});

describe('after a refused import', () => {
  it('keeps the preview and its choices, and Import can be pressed again', () => {
    const state = run(
      chose,
      { type: 'previewSent' },
      { type: 'previewed', preview: preview() },
      { type: 'toggled', option: 'archiveChats' },
      { type: 'importSent' },
      { type: 'failed', problem: 'Could not reach the server' }
    );
    expect(showsPreview(state)).toBe(true);
    expect(state.archiveChats).toBe(false);
    expect(canImport(state)).toBe(true);
  });

  it('a refused preview shows no preview at all', () => {
    expect(
      showsPreview(run(chose, { type: 'previewSent' }, { type: 'failed', problem: 'x' }))
    ).toBe(false);
  });

  it('the preview goes once the import lands', () => {
    const state = run(
      chose,
      { type: 'previewSent' },
      { type: 'previewed', preview: preview() },
      { type: 'importSent' },
      { type: 'imported', outcome, notes: [] }
    );
    expect(showsPreview(state)).toBe(false);
  });
});

describe('reading the server’s answers', () => {
  it('reads a preview, dropping what is not the right shape', () => {
    expect(previewFromAnswer({ preview: preview() })).toEqual(preview());
    expect(
      previewFromAnswer({
        preview: {
          sources: ['Claude', 3],
          chats: -1,
          sampleChats: [{ title: 'A', messages: 2 }, { x: 1 }],
        },
      })
    ).toEqual({
      sources: ['Claude'],
      memories: 0,
      chats: 0,
      messages: 0,
      sampleMemories: [],
      sampleChats: [{ title: 'A', messages: 2 }],
      notes: [],
    });
    expect(previewFromAnswer({})).toBeNull();
    expect(previewFromAnswer(null)).toBeNull();
  });

  it('reads an outcome and its notes', () => {
    expect(importedFromAnswer({ imported: outcome, notes: ['n'] })).toEqual({
      outcome,
      notes: ['n'],
    });
    expect(
      importedFromAnswer({ imported: { ...outcome, stopped: 'weird' } })?.outcome.stopped
    ).toBeNull();
    expect(importedFromAnswer({ notes: [] })).toBeNull();
  });
});
