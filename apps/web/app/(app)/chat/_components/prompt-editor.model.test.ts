import type { ModelOption } from '@/lib/chat/views';
import {
  askLabel,
  bodyLocked,
  canAccept,
  canRefine,
  canSave,
  drafting,
  editorOpen,
  guidanceLabel,
  initialEditor,
  promptEditorReducer,
  promptQuestions,
  proposalUnchanged,
  questionsSummary,
  refineBody,
  refineButtonLabel,
  refineHeading,
  refinedNote,
  saveBody,
  shouldAskNow,
  titleToTake,
  type PromptEditorAction,
  type PromptEditorState,
} from './prompt-editor.model';

const run = (...actions: PromptEditorAction[]): PromptEditorState =>
  actions.reduce(promptEditorReducer, initialEditor);

const model = (id: string, isDefault = false): ModelOption => ({
  id,
  label: `Model ${id}`,
  provider: 'openai',
  model: id,
  isDefault,
  supportsThinking: false,
  contextWindow: null,
});

const EXISTING = { id: 'p1', title: 'Review a file', body: 'review the file for bugs' };
const PROPOSAL = {
  body: 'Review {{file}} for bugs.\n\n```variables\nfile:\n  required: true\n```',
  title: null,
};
const editing = (...more: PromptEditorAction[]) =>
  run({ type: 'opened', prompt: EXISTING }, ...more);

describe('opening and closing the editor', () => {
  it('opens on a new prompt, empty', () => {
    const state = run({ type: 'opened', prompt: 'new' });
    expect(editorOpen(state)).toBe(true);
    expect(state.target).toBe('new');
    expect([state.title, state.body]).toEqual(['', '']);
  });

  it('opens on one of the library’s with its title and text', () => {
    const state = editing();
    expect(state.target).toEqual({ id: 'p1' });
    expect([state.title, state.body]).toEqual(['Review a file', 'review the file for bugs']);
  });

  it('closes, forgetting what was typed', () => {
    const state = editing({ type: 'bodyTyped', text: 'changed' }, { type: 'closed' });
    expect(editorOpen(state)).toBe(false);
    expect(state.body).toBe('');
  });
});

describe('saving', () => {
  it('needs a title and some text', () => {
    expect(canSave(run({ type: 'opened', prompt: 'new' }))).toBe(false);
    expect(canSave(run({ type: 'opened', prompt: 'new' }, { type: 'titleTyped', text: 'T' }))).toBe(
      false
    );
    expect(canSave(editing())).toBe(true);
    expect(canSave(editing({ type: 'bodyTyped', text: '   ' }))).toBe(false);
  });

  it('sends the title and text trimmed', () => {
    const state = editing(
      { type: 'titleTyped', text: '  Review  ' },
      { type: 'bodyTyped', text: '  Do it.  ' }
    );
    expect(saveBody(state)).toEqual({ title: 'Review', body: 'Do it.' });
  });

  it('cannot be pressed twice, and a failure leaves the text and says why', () => {
    const saving = editing({ type: 'saveStarted' });
    expect(canSave(saving)).toBe(false);
    const failed = promptEditorReducer(saving, { type: 'saveFailed', error: 'offline' });
    expect(canSave(failed)).toBe(true);
    expect(failed.error).toBe('offline');
    expect(failed.body).toBe('review the file for bugs');
  });

  it('closes the editor when it lands', () => {
    expect(editorOpen(editing({ type: 'saveStarted' }, { type: 'saved' }))).toBe(false);
  });
});

describe('refine, with a draft', () => {
  it('opens the dialog and waits for the roster to ask', () => {
    const state = editing({ type: 'refineOpened' });
    expect(state.refine.open).toBe(true);
    expect(shouldAskNow(state)).toBe(false);
    const loaded = promptEditorReducer(state, {
      type: 'modelsLoaded',
      models: [model('a'), model('b', true)],
    });
    expect(shouldAskNow(loaded)).toBe(true);
    expect(loaded.refine.modelId).toBe('b');
  });

  it('asks with the title and draft as they stand, what was said and the model chosen', () => {
    const state = editing(
      { type: 'titleTyped', text: ' Review ' },
      { type: 'bodyTyped', text: ' review it ' },
      { type: 'refineOpened' },
      { type: 'modelsLoaded', models: [model('a'), model('b')] },
      { type: 'modelPicked', modelId: 'b' },
      { type: 'guidanceTyped', text: '  ask which file ' }
    );
    expect(refineBody(state)).toEqual({
      title: 'Review',
      body: 'review it',
      guidance: 'ask which file',
      llmModelId: 'b',
    });
  });

  it('shows working while it asks, and the proposal when it lands', () => {
    const asking = editing({ type: 'refineOpened' }, { type: 'refineStarted' });
    expect(askLabel(asking)).toBe('Refining…');
    expect(bodyLocked(asking)).toBe(true);
    const answered = promptEditorReducer(asking, { type: 'refineAnswered', proposal: PROPOSAL });
    expect(answered.refine.proposal).toEqual(PROPOSAL);
    expect(askLabel(answered)).toBe('Try again');
    expect(bodyLocked(answered)).toBe(false);
  });

  it('keeps the text and says why when the ask fails', () => {
    const state = editing(
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineFailed', error: 'The model could not refine the prompt. Try again.' }
    );
    expect(state.refine.error).toMatch(/could not refine/);
    expect(askLabel(state)).toBe('Try again');
    expect(state.body).toBe('review the file for bugs');
  });

  it('drops an answer that lands after Cancel', () => {
    const state = editing(
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineClosed' },
      { type: 'refineAnswered', proposal: PROPOSAL }
    );
    expect(state.refine.proposal).toBeNull();
    expect(state.refine.open).toBe(false);
  });

  it('Accept puts the rewrite in the text, unsaved, and says so until it is changed', () => {
    const state = editing(
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineAnswered', proposal: PROPOSAL },
      { type: 'proposalAccepted' }
    );
    expect(state.body).toBe(PROPOSAL.body);
    expect(state.refine.open).toBe(false);
    expect(refinedNote(state)).toBe('Refined, not saved yet. Save to keep it.');
    expect(
      refinedNote(promptEditorReducer(state, { type: 'bodyTyped', text: 'edited' }))
    ).toBeNull();
  });

  it('cannot Accept a rewrite that says what the draft says', () => {
    const state = editing(
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineAnswered', proposal: { body: ' review the file for bugs ', title: null } }
    );
    expect(proposalUnchanged(state)).toBe(true);
    expect(canAccept(state)).toBe(false);
  });

  it('keeps the roster and the model for the next dialog', () => {
    const state = editing(
      { type: 'refineOpened' },
      { type: 'modelsLoaded', models: [model('a'), model('b')] },
      { type: 'modelPicked', modelId: 'b' },
      { type: 'refineClosed' },
      { type: 'refineOpened' }
    );
    expect(state.refine.models).toHaveLength(2);
    expect(state.refine.modelId).toBe('b');
  });
});

describe('refine, with no draft: it drafts from a description', () => {
  const blank = () => run({ type: 'opened', prompt: 'new' });

  it('is called Draft, and waits to be told what the prompt is for', () => {
    const state = promptEditorReducer(blank(), { type: 'refineOpened' });
    expect(drafting(state)).toBe(true);
    expect(refineButtonLabel(state)).toBe('Draft with AI');
    expect(refineHeading(state)).toBe('Draft prompt');
    expect(askLabel(state)).toBe('Draft');
    expect(guidanceLabel(state)).toMatch(/What is this prompt for/);
    // It does not ask on its own: there is nothing yet to go on.
    const loaded = promptEditorReducer(state, { type: 'modelsLoaded', models: [model('a')] });
    expect(shouldAskNow(loaded)).toBe(false);
    expect(canRefine(loaded)).toBe(false);
  });

  it('can be asked once there is a description', () => {
    const state = run(
      { type: 'opened', prompt: 'new' },
      { type: 'refineOpened' },
      { type: 'guidanceTyped', text: 'plans a database migration' }
    );
    expect(canRefine(state)).toBe(true);
    expect(refineBody(state)).toEqual({
      title: '',
      body: '',
      guidance: 'plans a database migration',
    });
  });

  it('is Refine again once there is text', () => {
    const state = editing();
    expect(refineButtonLabel(state)).toBe('Refine');
    expect(refineHeading(state)).toBe('Refine prompt');
    expect(guidanceLabel(state)).toMatch(/Anything to change/);
  });
});

describe('a suggested title', () => {
  const withProposal = (title: string) =>
    run(
      { type: 'opened', prompt: 'new' },
      { type: 'titleTyped', text: title },
      { type: 'refineOpened' },
      { type: 'guidanceTyped', text: 'reviews a file' },
      { type: 'refineStarted' },
      { type: 'refineAnswered', proposal: { body: 'Review {{file}}.', title: 'Review a file' } }
    );

  it('fills an empty title', () => {
    const state = withProposal('');
    expect(titleToTake(state)).toBe('Review a file');
    expect(promptEditorReducer(state, { type: 'proposalAccepted' }).title).toBe('Review a file');
  });

  it('never replaces a title the editor wrote', () => {
    const state = withProposal('My own title');
    expect(titleToTake(state)).toBeNull();
    expect(promptEditorReducer(state, { type: 'proposalAccepted' }).title).toBe('My own title');
  });

  it('counts as a change on its own, when the text is the same', () => {
    const state = run(
      { type: 'opened', prompt: { id: 'p1', title: '', body: 'Do it.' } },
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineAnswered', proposal: { body: 'Do it.', title: 'Do it' } }
    );
    expect(proposalUnchanged(state)).toBe(false);
    expect(canAccept(state)).toBe(true);
  });
});

describe('the questions a prompt asks', () => {
  const body =
    'Review {{file}} for {{focus:choice}} in {{areas:multi}}.\n\n```variables\nfile:\n  required: true\nfocus:\n  options: [security, performance]\nareas:\n  options: [api, ui]\n```';

  it('are listed with their kind, options and whether they are required', () => {
    expect(promptQuestions(body).rows).toEqual([
      { name: 'file', label: 'File', detail: 'Short text · required' },
      { name: 'focus', label: 'Focus', detail: 'Choose one · security, performance' },
      { name: 'areas', label: 'Areas', detail: 'Choose several · api, ui' },
    ]);
    expect(promptQuestions(body).problems).toEqual([]);
  });

  it('carry the parser’s problems, so a broken prompt says what is wrong', () => {
    expect(promptQuestions('Pick {{c:choice}}').problems).toEqual([
      '"c" is a choice but lists no options, asking for text instead.',
    ]);
  });

  it('are summed up under the text, and not at all for a prompt that asks none', () => {
    expect(questionsSummary(body)).toBe('Asks 3 questions when picked.');
    expect(questionsSummary('Review {{file}}.')).toBe('Asks 1 question when picked.');
    expect(questionsSummary('Review the repository.')).toBeNull();
  });
});
