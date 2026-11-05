import type { ModelOption } from '@/lib/chat/views';
import {
  aboutReducer,
  askLabel,
  canAccept,
  canRefine,
  canSave,
  initialAbout,
  instructionsLocked,
  isDirty,
  proposalUnchanged,
  refineBody,
  refinedUnsaved,
  saveBody,
  shouldAskNow,
  type AboutAction,
  type AboutState,
} from './project-about.model';

const model = (id: string, isDefault = false): ModelOption => ({
  id,
  label: `Model ${id}`,
  provider: 'openai',
  model: id,
  isDefault,
  supportsThinking: false,
  contextWindow: null,
});

const start = (instructions: string | null = 'help w/ hiring. be nice') =>
  initialAbout({
    project: { name: 'Hiring', description: null, instructions },
    defaultInstructions: null,
  });

const fold = (state: AboutState, ...actions: AboutAction[]) => actions.reduce(aboutReducer, state);

const PROPOSAL = {
  instructions: '# Hiring\n\nYou help run interview loops. Be warm and direct.',
  changes: ['Added a heading', 'Spoke to the assistant directly'],
};

describe('the About form', () => {
  it('has nothing to save until something changes, and never an empty name', () => {
    const state = start();
    expect(canSave(state)).toBe(false);
    expect(canSave(fold(state, { type: 'fieldTyped', field: 'description', value: 'Loops' }))).toBe(
      true
    );
    expect(canSave(fold(state, { type: 'fieldTyped', field: 'name', value: '  ' }))).toBe(false);
  });

  it('sends the fields trimmed, with an emptied description or instructions as none', () => {
    const state = fold(
      start(),
      { type: 'fieldTyped', field: 'name', value: ' Hiring 2027 ' },
      { type: 'fieldTyped', field: 'instructions', value: '   ' }
    );
    expect(saveBody(state)).toEqual({ name: 'Hiring 2027', description: null, instructions: null });
  });

  it('a code project starts with its standing brief in the field, unsaved', () => {
    const state = initialAbout({
      project: { name: 'API', description: null, instructions: null },
      defaultInstructions: 'You are a developer.',
    });
    expect(state.fields.instructions).toBe('You are a developer.');
    expect(isDirty(state)).toBe(true);
  });

  it('once saved, is clean again with what the server stored', () => {
    const state = fold(
      start(),
      { type: 'fieldTyped', field: 'description', value: ' Loops ' },
      { type: 'saveStarted' },
      { type: 'saved', at: 5 }
    );
    expect(isDirty(state)).toBe(false);
    expect(state.saved.description).toBe('Loops');
    expect(state.savedAt).toBe(5);
  });

  it('a refused save keeps the edits and says why', () => {
    const state = fold(
      start(),
      { type: 'fieldTyped', field: 'name', value: 'X' },
      { type: 'saveStarted' },
      { type: 'saveFailed', error: 'Only editors can change this project.' }
    );
    expect(state.fields.name).toBe('X');
    expect(state.saveError).toBe('Only editors can change this project.');
    expect(canSave(state)).toBe(true);
  });

  it('the header rename saves the name alone, and a refused one puts the old name back', () => {
    const typed = fold(
      start(),
      { type: 'fieldTyped', field: 'description', value: 'Loops' },
      { type: 'fieldTyped', field: 'name', value: 'Hiring 2027' }
    );
    const renamed = fold(typed, { type: 'renameSaved', name: 'Hiring 2027', at: 1 });
    expect(renamed.saved.name).toBe('Hiring 2027');
    expect(renamed.fields.description).toBe('Loops');
    expect(isDirty(renamed)).toBe(true);
    const refused = fold(typed, { type: 'renameFailed', error: 'No' });
    expect(refused.fields.name).toBe('Hiring');
  });
});

describe('Refine', () => {
  it('needs instructions to work on, and does not open without them', () => {
    expect(canRefine(start(null))).toBe(false);
    expect(canRefine(start())).toBe(true);
    expect(fold(start(null), { type: 'refineOpened' }).refine.open).toBe(false);
  });

  it('asks the moment it opens, once the roster has come', () => {
    const opened = fold(start(), { type: 'refineOpened' });
    expect(shouldAskNow(opened)).toBe(false);
    expect(askLabel(opened)).toBe('Refining…');
    const ready = fold(opened, { type: 'modelsLoaded', models: [model('a', true)] });
    expect(shouldAskNow(ready)).toBe(true);
    const asking = fold(ready, { type: 'refineStarted' });
    expect(shouldAskNow(asking)).toBe(false);
  });

  it('a roster already loaded asks at once on the next opening', () => {
    const reopened = fold(
      start(),
      { type: 'refineOpened' },
      { type: 'modelsLoaded', models: [model('a', true)] },
      { type: 'refineClosed' },
      { type: 'refineOpened' }
    );
    expect(shouldAskNow(reopened)).toBe(true);
  });

  it('offers Try again beside the prompt once there is an answer or a failure, and Accept only for a finished rewrite', () => {
    const asked = fold(
      start(),
      { type: 'refineOpened' },
      { type: 'modelsLoaded', models: [model('a', true)] },
      { type: 'refineStarted' }
    );
    expect(canAccept(asked)).toBe(false);
    const answered = fold(asked, { type: 'refineAnswered', proposal: PROPOSAL });
    expect(askLabel(answered)).toBe('Try again');
    expect(canAccept(answered)).toBe(true);
    const again = fold(answered, { type: 'refineStarted' });
    expect(canAccept(again)).toBe(false);
    expect(aboutReducer(again, { type: 'proposalAccepted' })).toBe(again);
    expect(askLabel(fold(asked, { type: 'refineFailed', error: 'x' }))).toBe('Try again');
  });

  it('picks the organization’s default model, and keeps the one chosen across openings', () => {
    const loaded = fold(
      start(),
      { type: 'refineOpened' },
      {
        type: 'modelsLoaded',
        models: [model('a'), model('b', true)],
      }
    );
    expect(loaded.refine.modelId).toBe('b');
    const reopened = fold(
      loaded,
      { type: 'modelPicked', modelId: 'a' },
      { type: 'refineClosed' },
      { type: 'refineOpened' },
      { type: 'modelsLoaded', models: [model('a'), model('b', true)] }
    );
    expect(reopened.refine.modelId).toBe('a');
  });

  it('sends the draft as it stands in the field, what the editor asked for and the model', () => {
    const state = fold(
      start(),
      { type: 'fieldTyped', field: 'instructions', value: ' help with hiring, unsaved ' },
      { type: 'refineOpened' },
      { type: 'modelsLoaded', models: [model('a', true)] },
      { type: 'guidanceTyped', text: ' shorter ' }
    );
    expect(refineBody(state)).toEqual({
      instructions: 'help with hiring, unsaved',
      guidance: 'shorter',
      llmModelId: 'a',
    });
    expect(refineBody(fold(state, { type: 'guidanceTyped', text: '' }))).not.toHaveProperty(
      'guidance'
    );
  });

  it('locks the field while the model works, and a second press sends nothing', () => {
    const asking = fold(start(), { type: 'refineOpened' }, { type: 'refineStarted' });
    expect(instructionsLocked(asking)).toBe(true);
    expect(canRefine(asking)).toBe(false);
    expect(aboutReducer(asking, { type: 'refineStarted' })).toBe(asking);
  });

  it('taking the proposal puts it in the field, unsaved until Save', () => {
    const state = fold(
      start(),
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineAnswered', proposal: PROPOSAL },
      { type: 'proposalAccepted' }
    );
    expect(state.fields.instructions).toBe(PROPOSAL.instructions);
    expect(state.saved.instructions).toBe('help w/ hiring. be nice');
    expect(state.refine.open).toBe(false);
    expect(refinedUnsaved(state)).toBe(true);
    expect(canSave(state)).toBe(true);
    expect(saveBody(state).instructions).toBe(PROPOSAL.instructions);
    const saved = fold(state, { type: 'saveStarted' }, { type: 'saved', at: 9 });
    expect(refinedUnsaved(saved)).toBe(false);
  });

  it('typing over a taken proposal stops calling it refined', () => {
    const state = fold(
      start(),
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineAnswered', proposal: PROPOSAL },
      { type: 'proposalAccepted' },
      { type: 'fieldTyped', field: 'instructions', value: 'my own words' }
    );
    expect(refinedUnsaved(state)).toBe(false);
  });

  it('discarding the proposal leaves the draft as it was', () => {
    const state = fold(
      start(),
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineAnswered', proposal: PROPOSAL },
      { type: 'refineClosed' }
    );
    expect(state.fields.instructions).toBe('help w/ hiring. be nice');
    expect(state.refine.proposal).toBeNull();
    expect(isDirty(state)).toBe(false);
  });

  it('an answer that lands after Cancel is dropped', () => {
    const cancelled = fold(
      start(),
      { type: 'refineOpened' },
      { type: 'modelsLoaded', models: [model('a', true)] },
      { type: 'refineStarted' },
      { type: 'refineClosed' }
    );
    expect(aboutReducer(cancelled, { type: 'refineAnswered', proposal: PROPOSAL })).toBe(cancelled);
    expect(aboutReducer(cancelled, { type: 'refineFailed', error: 'x' })).toBe(cancelled);
  });

  it('a failed refine says why and can be asked again', () => {
    const state = fold(
      start(),
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineFailed', error: 'The model could not refine the instructions. Try again.' }
    );
    expect(state.refine.error).toMatch(/could not refine/);
    expect(instructionsLocked(state)).toBe(false);
    expect(fold(state, { type: 'refineStarted' }).refine.error).toBeNull();
  });

  it('a proposal that says the same as the draft is nothing to take', () => {
    const state = fold(
      start(),
      { type: 'refineOpened' },
      { type: 'refineStarted' },
      { type: 'refineAnswered', proposal: { instructions: 'help w/ hiring. be nice', changes: [] } }
    );
    expect(proposalUnchanged(state)).toBe(true);
    expect(canAccept(state)).toBe(false);
  });
});
