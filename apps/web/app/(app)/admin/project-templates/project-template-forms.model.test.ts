/**
 * The project-template catalog's admin form
 * (project-template-forms.model.ts), as an operator using it would
 * describe it. project-templates.spec.ts keeps the catalog rendering,
 * one template created for real, and it showing in the new-project
 * picker.
 */

import {
  canSave,
  initialTemplates,
  saveLabel,
  saveRequest,
  templatesReducer,
  type TemplateRow,
  type TemplatesAction,
  type TemplatesState,
} from './project-template-forms.model';

const fullStack: TemplateRow = {
  id: 't-full',
  name: 'Full-stack application',
  description: 'A web app with a frontend, a backend and a database behind it.',
  instructions: 'You are a professional full-stack developer.',
};
const sql: TemplateRow = {
  id: 't-sql',
  name: 'SQL report',
  description: null,
  instructions: 'Validate.',
};

const run = (actions: TemplatesAction[], from: TemplatesState = initialTemplates) =>
  actions.reduce(templatesReducer, from);

const loaded = run([{ type: 'loaded', templates: [fullStack, sql] }]);

describe('the catalog', () => {
  it('lists the templates as loaded, seeded rows like any other', () => {
    expect(loaded.templates.map((row) => row.name)).toEqual([
      'Full-stack application',
      'SQL report',
    ]);
  });

  it('a failed load says why', () => {
    expect(run([{ type: 'loadFailed', error: 'Unauthorized' }]).error).toBe('Unauthorized');
  });
});

describe('a new template', () => {
  it('starts empty, Create off until it has a name and instructions', () => {
    const blank = run([{ type: 'newTemplate' }], loaded);
    expect(saveLabel(blank)).toBe('Create template');
    expect(canSave(blank)).toBe(false);
    const named = run([{ type: 'draftChanged', field: 'name', value: 'Mine' }], blank);
    expect(canSave(named)).toBe(false);
    const spaces = run([{ type: 'draftChanged', field: 'instructions', value: '   ' }], named);
    expect(canSave(spaces)).toBe(false);
    const ready = run(
      [{ type: 'draftChanged', field: 'instructions', value: 'Run pnpm test.' }],
      named
    );
    expect(canSave(ready)).toBe(true);
  });

  it('Create posts the trimmed fields, an empty description as none', () => {
    const ready = run(
      [
        { type: 'newTemplate' },
        { type: 'draftChanged', field: 'name', value: '  Mine  ' },
        { type: 'draftChanged', field: 'description', value: '   ' },
        {
          type: 'draftChanged',
          field: 'instructions',
          value: ' Run pnpm test before every commit. ',
        },
      ],
      loaded
    );
    expect(saveRequest(ready)).toEqual({
      method: 'POST',
      url: '/api/admin/project-templates',
      body: { name: 'Mine', description: null, instructions: 'Run pnpm test before every commit.' },
    });
  });
});

describe('editing', () => {
  it('Edit opens a draft filled with the row’s current text', () => {
    const editing = run([{ type: 'edit', template: fullStack }], loaded);
    expect(editing.draft).toEqual({
      id: 't-full',
      name: 'Full-stack application',
      description: 'A web app with a frontend, a backend and a database behind it.',
      instructions: 'You are a professional full-stack developer.',
    });
    expect(saveLabel(editing)).toBe('Save template');
    expect(run([{ type: 'edit', template: sql }], loaded).draft?.description).toBe('');
  });

  it('Save puts the edit to that template', () => {
    const editing = run(
      [
        { type: 'edit', template: fullStack },
        { type: 'draftChanged', field: 'name', value: 'Full stack' },
      ],
      loaded
    );
    expect(saveRequest(editing)).toMatchObject({
      method: 'PUT',
      url: '/api/admin/project-templates/t-full',
      body: { name: 'Full stack' },
    });
  });

  it('Cancel closes the draft, sending nothing', () => {
    const cancelled = run(
      [{ type: 'edit', template: fullStack }, { type: 'draftCancelled' }],
      loaded
    );
    expect(cancelled.draft).toBeNull();
    expect(saveRequest(cancelled)).toBeNull();
  });

  it('nothing can be saved while a save or delete is going', () => {
    const sending = run([{ type: 'edit', template: fullStack }, { type: 'sent' }], loaded);
    expect(canSave(sending)).toBe(false);
  });

  it('a refused save keeps the draft and says why; a saved one closes it', () => {
    const editing = run([{ type: 'edit', template: fullStack }, { type: 'sent' }], loaded);
    const refused = run([{ type: 'failed', error: 'A template with that name exists' }], editing);
    expect(refused.draft?.id).toBe('t-full');
    expect(refused.error).toBe('A template with that name exists');
    expect(run([{ type: 'saved' }], editing).draft).toBeNull();
  });
});

describe('deleting', () => {
  it('deleting the template being edited closes its draft', () => {
    const editing = run([{ type: 'edit', template: fullStack }, { type: 'sent' }], loaded);
    expect(run([{ type: 'removed', id: 't-full' }], editing).draft).toBeNull();
  });

  it('deleting another template leaves the draft open', () => {
    const editing = run([{ type: 'edit', template: fullStack }, { type: 'sent' }], loaded);
    expect(run([{ type: 'removed', id: 't-sql' }], editing).draft?.id).toBe('t-full');
  });
});
