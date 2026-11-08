import {
  canSaveSettings,
  initialLibrarySettings,
  librarySettingsReducer,
  settingsBody,
  type LibrarySettingsAction,
  type LibrarySettingsState,
} from './library-settings.model';

const run = (...actions: LibrarySettingsAction[]): LibrarySettingsState =>
  actions.reduce(librarySettingsReducer, initialLibrarySettings);

const LIBRARY = { name: 'Code review', description: 'Prompts for reviews' };
const editing = (...more: LibrarySettingsAction[]) =>
  run({ type: 'opened', library: LIBRARY }, ...more);

describe('opening the dialog', () => {
  it('starts from the library as it is now', () => {
    const state = editing();
    expect(state.open).toBe(true);
    expect(state.name).toBe('Code review');
    expect(state.description).toBe('Prompts for reviews');
  });

  it('shows a library with no description as an empty field', () => {
    const state = run({ type: 'opened', library: { name: 'Notes', description: null } });
    expect(state.description).toBe('');
  });

  it('closing drops what was typed', () => {
    const state = editing({ type: 'nameTyped', text: 'Renamed' }, { type: 'closed' });
    expect(state).toEqual(initialLibrarySettings);
  });
});

describe('Save', () => {
  it('is off while the name is blank, and on once it says something', () => {
    const blank = editing({ type: 'nameTyped', text: '   ' });
    expect(canSaveSettings(blank)).toBe(false);
    expect(canSaveSettings(editing({ type: 'nameTyped', text: 'Triage' }))).toBe(true);
  });

  it('is off past the name limit', () => {
    const long = editing({ type: 'nameTyped', text: 'x'.repeat(201) });
    expect(canSaveSettings(long)).toBe(false);
  });

  it('sends the trimmed name and description', () => {
    const state = editing(
      { type: 'nameTyped', text: '  Triage  ' },
      { type: 'descriptionTyped', text: ' For bug reports ' }
    );
    expect(settingsBody(state)).toEqual({ name: 'Triage', description: 'For bug reports' });
  });

  it('sends an empty description when it is cleared, so the server drops it', () => {
    const state = editing({ type: 'descriptionTyped', text: '   ' });
    expect(settingsBody(state)).toEqual({ name: 'Code review', description: '' });
  });

  it('is off while the save is in flight', () => {
    const saving = editing({ type: 'saveStarted' });
    expect(canSaveSettings(saving)).toBe(false);
  });

  it('a refused save keeps what was typed and shows why', () => {
    const state = editing(
      { type: 'nameTyped', text: 'Triage' },
      { type: 'saveStarted' },
      { type: 'saveFailed', error: 'The name cannot be empty' }
    );
    expect(state.open).toBe(true);
    expect(state.name).toBe('Triage');
    expect(state.busy).toBe(false);
    expect(state.error).toBe('The name cannot be empty');
  });

  it('a saved change closes the dialog', () => {
    const state = editing(
      { type: 'nameTyped', text: 'Triage' },
      { type: 'saveStarted' },
      { type: 'saved' }
    );
    expect(state).toEqual(initialLibrarySettings);
  });

  it('typing again clears the last error', () => {
    const state = editing(
      { type: 'saveFailed', error: 'Something went wrong' },
      { type: 'nameTyped', text: 'Triage' }
    );
    expect(state.error).toBeNull();
  });
});
