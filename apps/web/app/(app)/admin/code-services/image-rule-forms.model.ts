/**
 * The service image allow-list (image-rule-forms.tsx), with no network or
 * React: the rules as last loaded, the one draft (new rule or edit), what
 * a rule's shape reads as, when Save can be pressed (a credential is a
 * username AND a secret, or neither), what Save sends and where, how the
 * credential a rule carries is kept, replaced or removed, and what each
 * answer leaves on screen. Tested in image-rule-forms.model.test.ts.
 */

export interface RuleRow {
  id: string;
  pattern: string;
  note: string | null;
  registryUsername: string | null;
}

export interface RuleDraft {
  /** null for a new rule. */
  id: string | null;
  pattern: string;
  note: string;
  registryUsername: string;
  registrySecret: string;
  /** Editing a rule that carries a credential: keep it unless a new pair or a clear says otherwise. */
  hasCredential: boolean;
  clearCredential: boolean;
}

export interface ImageRulesState {
  rules: RuleRow[];
  draft: RuleDraft | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
}

export const initialImageRules: ImageRulesState = {
  rules: [],
  draft: null,
  busy: false,
  error: null,
  notice: null,
};

export const EMPTY_DRAFT: RuleDraft = {
  id: null,
  pattern: '',
  note: '',
  registryUsername: '',
  registrySecret: '',
  hasCredential: false,
  clearCredential: false,
};

export type ImageRulesAction =
  | { type: 'loaded'; rules: RuleRow[] }
  | { type: 'load-failed'; error: string }
  | { type: 'new' }
  | { type: 'edit'; rule: RuleRow }
  | {
      type: 'draft';
      patch: Partial<Pick<RuleDraft, 'pattern' | 'note' | 'registryUsername' | 'registrySecret'>>;
    }
  | { type: 'clear-credential' }
  | { type: 'keep-credential' }
  | { type: 'cancel' }
  /** A save, delete or restore went out. */
  | { type: 'sent' }
  | { type: 'saved'; dropped: string | null }
  | { type: 'removed'; ruleId: string }
  | { type: 'restored'; added: number }
  | { type: 'failed'; error: string };

/** The draft an existing rule opens as: its pattern and note, no credential typed. */
export function draftOf(rule: RuleRow): RuleDraft {
  return {
    id: rule.id,
    pattern: rule.pattern,
    note: rule.note ?? '',
    registryUsername: '',
    registrySecret: '',
    hasCredential: rule.registryUsername !== null,
    clearCredential: false,
  };
}

export function imageRulesReducer(
  state: ImageRulesState,
  action: ImageRulesAction
): ImageRulesState {
  switch (action.type) {
    case 'loaded':
      return { ...state, rules: action.rules };
    case 'load-failed':
      return { ...state, error: action.error };
    case 'new':
      return { ...state, draft: EMPTY_DRAFT };
    case 'edit':
      return { ...state, draft: draftOf(action.rule) };
    case 'draft': {
      if (!state.draft) return state;
      const typesCredential =
        action.patch.registryUsername !== undefined || action.patch.registrySecret !== undefined;
      return {
        ...state,
        draft: {
          ...state.draft,
          ...action.patch,
          // Typing a new pair is replacing the credential, not removing it.
          ...(typesCredential ? { clearCredential: false } : {}),
        },
      };
    }
    case 'clear-credential':
      return state.draft ? { ...state, draft: { ...state.draft, clearCredential: true } } : state;
    case 'keep-credential':
      return state.draft ? { ...state, draft: { ...state.draft, clearCredential: false } } : state;
    case 'cancel':
      return { ...state, draft: null };
    case 'sent':
      return { ...state, busy: true, error: null, notice: null };
    case 'saved':
      return {
        ...state,
        busy: false,
        draft: null,
        notice: action.dropped
          ? `Saved without ${action.dropped}: a rule allows a repository at any tag.`
          : null,
      };
    case 'removed':
      // Deleting the rule being edited closes its form.
      return {
        ...state,
        busy: false,
        draft: state.draft?.id === action.ruleId ? null : state.draft,
      };
    case 'restored':
      return {
        ...state,
        busy: false,
        notice:
          action.added === 0
            ? 'The default images are all in the list already.'
            : `Put ${action.added} default ${action.added === 1 ? 'image' : 'images'} back.`,
      };
    case 'failed':
      // The draft stays as typed, with the reason beside it.
      return { ...state, busy: false, error: action.error };
  }
}

/** What a rule's shape says at a glance. */
export function shapeOf(pattern: string): string {
  if (pattern.endsWith('/*')) return 'namespace';
  return pattern.includes('/') ? 'repository' : 'whole registry';
}

/** Save needs a rule, and a credential is both halves or neither. */
export function canSave(state: ImageRulesState): boolean {
  const { draft } = state;
  if (!draft || state.busy || !draft.pattern.trim()) return false;
  return Boolean(draft.registryUsername.trim()) === Boolean(draft.registrySecret);
}

/** What the credential note under the draft says. */
export function credentialNote(draft: RuleDraft): 'carries' | 'removing' | null {
  if (draft.clearCredential) return 'removing';
  return draft.hasCredential ? 'carries' : null;
}

/**
 * What Save sends, and where: a new rule is a POST to the list, an edit a
 * PUT to the rule. A credential goes only as a typed pair; with none typed
 * the stored one is kept unless removing it was chosen.
 */
export function saveRequest(draft: RuleDraft): {
  url: string;
  method: 'POST' | 'PUT';
  body: Record<string, unknown>;
} {
  const username = draft.registryUsername.trim();
  return {
    url: draft.id ? `/api/admin/code-services/rules/${draft.id}` : `/api/admin/code-services/rules`,
    method: draft.id ? 'PUT' : 'POST',
    body: {
      pattern: draft.pattern.trim(),
      note: draft.note.trim() || null,
      ...(username ? { registryUsername: username, registrySecret: draft.registrySecret } : {}),
      ...(draft.clearCredential ? { clearCredential: true } : {}),
    },
  };
}
