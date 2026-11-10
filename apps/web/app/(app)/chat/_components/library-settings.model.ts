/**
 * A library's name and description, edited in a dialog from the library page
 * (library-view.tsx). Save sends both (PATCH .../[libraryId]); the name must
 * say something, the description may be cleared. Tested in
 * library-settings.model.test.ts.
 */

export const LIBRARY_NAME_LIMIT = 200;
export const LIBRARY_DESCRIPTION_LIMIT = 2_000;

export interface LibrarySettingsState {
  open: boolean;
  name: string;
  description: string;
  busy: boolean;
  error: string | null;
}

export const initialLibrarySettings: LibrarySettingsState = {
  open: false,
  name: '',
  description: '',
  busy: false,
  error: null,
};

export type LibrarySettingsAction =
  | { type: 'opened'; library: { name: string; description: string | null } }
  | { type: 'closed' }
  | { type: 'nameTyped'; text: string }
  | { type: 'descriptionTyped'; text: string }
  | { type: 'saveStarted' }
  | { type: 'saveFailed'; error: string }
  | { type: 'saved' };

export function librarySettingsReducer(
  state: LibrarySettingsState,
  action: LibrarySettingsAction
): LibrarySettingsState {
  switch (action.type) {
    case 'opened':
      return {
        ...initialLibrarySettings,
        open: true,
        name: action.library.name,
        description: action.library.description ?? '',
      };
    case 'closed':
    case 'saved':
      return initialLibrarySettings;
    case 'nameTyped':
      return { ...state, name: action.text, error: null };
    case 'descriptionTyped':
      return { ...state, description: action.text, error: null };
    case 'saveStarted':
      return { ...state, busy: true, error: null };
    case 'saveFailed':
      return { ...state, busy: false, error: action.error };
  }
}

/** Save needs a name, and is off while one is already in flight. */
export function canSaveSettings(state: LibrarySettingsState): boolean {
  const name = state.name.trim();
  return !state.busy && name !== '' && name.length <= LIBRARY_NAME_LIMIT;
}

/** What Save sends: trimmed; an empty description is sent as '' so the server clears it. */
export function settingsBody(state: LibrarySettingsState): { name: string; description: string } {
  return { name: state.name.trim(), description: state.description.trim() };
}
