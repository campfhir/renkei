/**
 * The service image allow-list (image-rule-forms.model.ts), as an operator
 * would describe it. These were code-services.spec.ts's rule steps (the
 * shapes, the credential kept or removed, the tag-dropped and restored
 * notices, a refused duplicate); what the routes pass to and from the
 * sandbox worker is app/api/admin/code-services/rules/route.test.ts.
 */

import {
  canSave,
  credentialNote,
  EMPTY_DRAFT,
  imageRulesReducer,
  initialImageRules,
  saveRequest,
  shapeOf,
  type ImageRulesAction,
  type ImageRulesState,
  type RuleRow,
} from './image-rule-forms.model';

const run = (actions: ImageRulesAction[], from: ImageRulesState = initialImageRules) =>
  actions.reduce(imageRulesReducer, from);

const rule = (id: string, more: Partial<RuleRow> = {}): RuleRow => ({
  id,
  pattern: `docker.io/library/${id}`,
  note: null,
  registryUsername: null,
  ...more,
});

const REGISTRY = rule('r-1', {
  pattern: 'acme1.azurecr.io',
  note: 'Our platform team’s registry',
  registryUsername: 'sp-renkei-pull',
});

describe('a rule’s shape', () => {
  it('reads a bare host as the whole registry, a trailing /* as a namespace, else a repository', () => {
    expect(shapeOf('acme1.azurecr.io')).toBe('whole registry');
    expect(shapeOf('acme1.azurecr.io/platform/*')).toBe('namespace');
    expect(shapeOf('docker.io/library/redis')).toBe('repository');
  });
});

describe('a new rule', () => {
  it('Save needs a rule typed', () => {
    const open = run([{ type: 'new' }]);
    expect(canSave(open)).toBe(false);
    expect(canSave(run([{ type: 'draft', patch: { pattern: '  ' } }], open))).toBe(false);
    expect(canSave(run([{ type: 'draft', patch: { pattern: 'postgres' } }], open))).toBe(true);
  });

  it('a credential is a username and a secret together, or neither', () => {
    const typed = run([{ type: 'new' }, { type: 'draft', patch: { pattern: 'acme1.azurecr.io' } }]);
    expect(canSave(run([{ type: 'draft', patch: { registryUsername: 'sp' } }], typed))).toBe(false);
    expect(canSave(run([{ type: 'draft', patch: { registrySecret: 's' } }], typed))).toBe(false);
    expect(
      canSave(
        run([{ type: 'draft', patch: { registryUsername: 'sp', registrySecret: 's' } }], typed)
      )
    ).toBe(true);
  });

  it('is a POST to the list, trimmed, with the pair and the note', () => {
    const state = run([
      { type: 'new' },
      {
        type: 'draft',
        patch: {
          pattern: ' ACME1.AZURECR.IO/ ',
          note: ' Our platform team’s registry ',
          registryUsername: ' sp-renkei-pull ',
          registrySecret: 'super-secret-value',
        },
      },
    ]);
    expect(saveRequest(state.draft ?? EMPTY_DRAFT)).toEqual({
      url: '/api/admin/code-services/rules',
      method: 'POST',
      body: {
        // The worker normalizes it; the form sends what was typed, trimmed.
        pattern: 'ACME1.AZURECR.IO/',
        note: 'Our platform team’s registry',
        registryUsername: 'sp-renkei-pull',
        registrySecret: 'super-secret-value',
      },
    });
  });

  it('a blank note is sent as none, and no credential when none is typed', () => {
    const state = run([{ type: 'new' }, { type: 'draft', patch: { pattern: 'postgres' } }]);
    expect(saveRequest(state.draft ?? EMPTY_DRAFT).body).toEqual({
      pattern: 'postgres',
      note: null,
    });
  });
});

describe('editing a rule with a credential', () => {
  const editing = run([
    { type: 'loaded', rules: [REGISTRY] },
    { type: 'edit', rule: REGISTRY },
  ]);

  it('opens with its pattern and note, the credential noted but never filled in', () => {
    expect(editing.draft).toMatchObject({
      id: 'r-1',
      pattern: 'acme1.azurecr.io',
      note: 'Our platform team’s registry',
      registryUsername: '',
      registrySecret: '',
    });
    expect(credentialNote(editing.draft ?? EMPTY_DRAFT)).toBe('carries');
  });

  it('saving untouched is a PUT to the rule that keeps the credential', () => {
    expect(saveRequest(editing.draft ?? EMPTY_DRAFT)).toEqual({
      url: '/api/admin/code-services/rules/r-1',
      method: 'PUT',
      body: { pattern: 'acme1.azurecr.io', note: 'Our platform team’s registry' },
    });
  });

  it('“remove it” says the credential goes on save, and sends that', () => {
    const removing = run([{ type: 'clear-credential' }], editing);
    expect(credentialNote(removing.draft ?? EMPTY_DRAFT)).toBe('removing');
    expect(saveRequest(removing.draft ?? EMPTY_DRAFT).body).toMatchObject({
      clearCredential: true,
    });
  });

  it('“keep it” takes the removal back', () => {
    const kept = run([{ type: 'clear-credential' }, { type: 'keep-credential' }], editing);
    expect(credentialNote(kept.draft ?? EMPTY_DRAFT)).toBe('carries');
    expect(saveRequest(kept.draft ?? EMPTY_DRAFT).body).not.toHaveProperty('clearCredential');
  });

  it('typing a new pair replaces the credential instead of removing it', () => {
    const replacing = run(
      [{ type: 'clear-credential' }, { type: 'draft', patch: { registryUsername: 'sp-2' } }],
      editing
    );
    expect(replacing.draft?.clearCredential).toBe(false);
  });

  it('a rule with no credential notes none', () => {
    const plain = run([{ type: 'edit', rule: rule('redis') }]);
    expect(credentialNote(plain.draft ?? EMPTY_DRAFT)).toBeNull();
  });
});

describe('answers', () => {
  it('a rule saved without its tag says so, and closes the form', () => {
    const state = run([
      { type: 'new' },
      { type: 'draft', patch: { pattern: 'bitnami/postgresql:16' } },
      { type: 'sent' },
      { type: 'saved', dropped: 'the tag 16' },
    ]);
    expect(state.notice).toBe('Saved without the tag 16: a rule allows a repository at any tag.');
    expect(state.draft).toBeNull();
  });

  it('a plain save says nothing', () => {
    expect(
      run([{ type: 'new' }, { type: 'sent' }, { type: 'saved', dropped: null }]).notice
    ).toBeNull();
  });

  it('a refused duplicate keeps the draft and shows why', () => {
    const state = run([
      { type: 'new' },
      { type: 'draft', patch: { pattern: 'postgres' } },
      { type: 'sent' },
      { type: 'failed', error: 'That rule already exists' },
    ]);
    expect(state.error).toBe('That rule already exists');
    expect(state.draft?.pattern).toBe('postgres');
    expect(state.busy).toBe(false);
  });

  it('anything sent clears the last notice and error', () => {
    const state = run([
      { type: 'failed', error: 'x' },
      { type: 'restored', added: 1 },
      { type: 'sent' },
    ]);
    expect(state.error).toBeNull();
    expect(state.notice).toBeNull();
    expect(canSave({ ...state, draft: { ...EMPTY_DRAFT, pattern: 'p' } })).toBe(false);
  });

  it('restoring says how many defaults came back, or that none were missing', () => {
    expect(run([{ type: 'restored', added: 1 }]).notice).toBe('Put 1 default image back.');
    expect(run([{ type: 'restored', added: 3 }]).notice).toBe('Put 3 default images back.');
    expect(run([{ type: 'restored', added: 0 }]).notice).toBe(
      'The default images are all in the list already.'
    );
  });

  it('deleting the rule being edited closes its form; deleting another keeps it', () => {
    const editing = run([{ type: 'edit', rule: REGISTRY }]);
    expect(run([{ type: 'sent' }, { type: 'removed', ruleId: 'r-1' }], editing).draft).toBeNull();
    expect(run([{ type: 'sent' }, { type: 'removed', ruleId: 'other' }], editing).draft?.id).toBe(
      'r-1'
    );
  });
});
