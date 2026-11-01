/**
 * The project-template catalog's admin form (project-template-forms.tsx):
 * the templates as last loaded, the one draft serving create and edit,
 * and what is in flight.
 *
 * The component makes the calls and dispatches their answers; when Save
 * is allowed, what it sends, and what a delete does to an open draft are
 * here, tested in project-template-forms.model.test.ts.
 */

export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
}

export interface Draft {
  /** null for a new template. */
  id: string | null;
  name: string;
  description: string;
  instructions: string;
}

export interface TemplatesState {
  templates: TemplateRow[];
  draft: Draft | null;
  busy: boolean;
  error: string | null;
}

export type TemplatesAction =
  | { type: 'loaded'; templates: TemplateRow[] }
  | { type: 'loadFailed'; error: string }
  | { type: 'newTemplate' }
  | { type: 'edit'; template: TemplateRow }
  | { type: 'draftChanged'; field: 'name' | 'description' | 'instructions'; value: string }
  | { type: 'draftCancelled' }
  | { type: 'sent' }
  | { type: 'saved' }
  | { type: 'removed'; id: string }
  | { type: 'failed'; error: string };

export const initialTemplates: TemplatesState = {
  templates: [],
  draft: null,
  busy: false,
  error: null,
};

export function templatesReducer(state: TemplatesState, action: TemplatesAction): TemplatesState {
  switch (action.type) {
    case 'loaded':
      return { ...state, templates: action.templates };
    case 'loadFailed':
      return { ...state, error: action.error };
    case 'newTemplate':
      return { ...state, draft: { id: null, name: '', description: '', instructions: '' } };
    case 'edit':
      return {
        ...state,
        draft: {
          id: action.template.id,
          name: action.template.name,
          description: action.template.description ?? '',
          instructions: action.template.instructions,
        },
      };
    case 'draftChanged':
      if (!state.draft) return state;
      return { ...state, draft: { ...state.draft, [action.field]: action.value } };
    case 'draftCancelled':
      return { ...state, draft: null };
    case 'sent':
      return { ...state, busy: true, error: null };
    case 'saved':
      return { ...state, busy: false, draft: null };
    case 'removed':
      // A draft editing what was just deleted would save it back.
      return {
        ...state,
        busy: false,
        draft: state.draft?.id === action.id ? null : state.draft,
      };
    case 'failed':
      return { ...state, busy: false, error: action.error };
  }
}

/** Save needs a name and instructions, and nothing else in flight. */
export function canSave(state: TemplatesState): boolean {
  const draft = state.draft;
  return !state.busy && !!draft && !!draft.name.trim() && !!draft.instructions.trim();
}

/** What Save sends: a POST for a new template, a PUT for an edit; null when it may not. */
export function saveRequest(state: TemplatesState): {
  method: 'POST' | 'PUT';
  url: string;
  body: { name: string; description: string | null; instructions: string };
} | null {
  const draft = state.draft;
  if (!draft || !draft.name.trim() || !draft.instructions.trim()) return null;
  return {
    method: draft.id ? 'PUT' : 'POST',
    url: draft.id ? `/api/admin/project-templates/${draft.id}` : '/api/admin/project-templates',
    body: {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      instructions: draft.instructions.trim(),
    },
  };
}

export function saveLabel(state: TemplatesState): string {
  return state.draft?.id ? 'Save template' : 'Create template';
}
