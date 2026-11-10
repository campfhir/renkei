/**
 * The library's one-file dialogs (artifact-dialogs.model.ts) — delete
 * with its impact, copy, rename — as their person would describe them.
 * artifacts.spec.ts walked delete-with-impact and rename by pressing; it
 * keeps the delete dialog drawn over a real impact at phone width, and
 * the rules are here. The impact itself is a route test
 * (app/api/chat/artifacts/[artifactId]/impact/route.test.ts).
 */

import type { ArtifactImpact } from '@/lib/chat/artifact-library';
import {
  aloneLine,
  copyReducer,
  copyRequest,
  defaultCopyName,
  deleteFooter,
  deleteReducer,
  deleteRequest,
  impactProjectLine,
  initialCopy,
  initialDelete,
  initialRename,
  othersUse,
  renameReducer,
  renameRequest,
  sharedWithLine,
  type DeleteAction,
  type DeleteState,
} from './artifact-dialogs.model';
import type { Person } from './share-modal.model';

const priya: Person = {
  subject: 'priya',
  email: 'priya@example.test',
  displayName: 'Priya Friend',
};

const project = (more: Partial<ArtifactImpact['projects'][number]> = {}) => ({
  id: 'p1',
  name: 'Billing API',
  kind: 'chat',
  members: 3,
  mode: 'on_demand' as const,
  ...more,
});

const used: ArtifactImpact = {
  projects: [project()],
  sharedWith: [{ subject: 'priya', name: 'Priya Friend', email: 'priya@example.test' }],
  chat: null,
};
const alone: ArtifactImpact = { projects: [], sharedWith: [], chat: null };

const run = (actions: DeleteAction[], from: DeleteState = initialDelete) =>
  actions.reduce(deleteReducer, from);
const loaded = (impact: ArtifactImpact | null, error: string | null = null) =>
  run([{ type: 'impactLoaded', impact, error }]);

describe('delete: the impact first', () => {
  it('cannot be confirmed while it works out who uses the file', () => {
    expect(initialDelete.impact).toBeNull();
    expect(deleteFooter(initialDelete).disabled).toBe(true);
  });

  it('when others use it, starts on handing it over, and waits for a new owner', () => {
    const state = loaded(used);
    expect(othersUse(state.impact)).toBe(true);
    expect(state.choice).toBe('transfer');
    expect(deleteFooter(state)).toEqual({ disabled: true, label: 'Hand over', danger: false });
  });

  it('with a new owner chosen, the button names them and hands it over', () => {
    const state = run([{ type: 'ownerChosen', person: priya }], loaded(used));
    expect(deleteFooter(state)).toEqual({
      disabled: false,
      label: 'Hand over to Priya Friend',
      danger: false,
    });
    expect(deleteRequest(state)).toEqual({ kind: 'transfer', newOwnerSubject: 'priya' });
  });

  it('deleting for everyone is a choice made on purpose, and is the red button', () => {
    const state = run(
      [
        { type: 'ownerChosen', person: priya },
        { type: 'choiceChanged', choice: 'delete' },
      ],
      loaded(used)
    );
    expect(deleteFooter(state)).toEqual({ disabled: false, label: 'Delete', danger: true });
    expect(deleteRequest(state)).toEqual({ kind: 'delete' });
  });

  it('a file nobody else uses is simply deleted', () => {
    const state = loaded(alone);
    expect(state.choice).toBe('delete');
    expect(deleteFooter(state)).toEqual({ disabled: false, label: 'Delete', danger: true });
    expect(aloneLine(alone)).toBe('Nobody else uses this file. It is removed for good.');
    expect(aloneLine({ ...alone, chat: { id: 'c', title: 'Fix rounding' } })).toBe(
      'Nobody else uses this file beyond the chat it came from. It is removed for good.'
    );
  });

  it('an impact that cannot be read shows why, and is treated as nobody else', () => {
    const state = loaded(null, 'No such file');
    expect(state.error).toBe('No such file');
    expect(state.impact).toEqual(alone);
    expect(state.choice).toBe('delete');
  });

  it('names each project with its members and whether it keeps the file in context', () => {
    expect(impactProjectLine(project())).toBe('Billing API · 3 members');
    expect(impactProjectLine(project({ members: 1, mode: 'always' }))).toBe(
      'Billing API · 1 member · kept in context'
    );
  });

  it('names the people it is shared with by name, else email', () => {
    expect(sharedWithLine(used)).toBe('Shared with Priya Friend');
    expect(
      sharedWithLine({
        ...alone,
        sharedWith: [
          { subject: 'a', name: null, email: 'a@example.test' },
          { subject: 'b', name: null, email: null },
        ],
      })
    ).toBe('Shared with a@example.test, …');
    expect(sharedWithLine(alone)).toBeNull();
  });

  it('a refused delete keeps the dialog open with why; another try clears it', () => {
    const refused = run(
      [{ type: 'sent' }, { type: 'failed', error: 'Not yours to delete' }],
      loaded(alone)
    );
    expect(refused).toMatchObject({ busy: false, error: 'Not yours to delete' });
    expect(run([{ type: 'sent' }], refused)).toMatchObject({ busy: true, error: null });
    expect(deleteFooter(run([{ type: 'sent' }], refused)).disabled).toBe(true);
  });
});

describe('copy', () => {
  it('suggests the name with "(copy)" before the extension', () => {
    expect(defaultCopyName('vendor-sdk-manual.txt')).toBe('vendor-sdk-manual (copy).txt');
    expect(defaultCopyName('README')).toBe('README (copy)');
    expect(defaultCopyName('.env')).toBe('.env (copy)');
    expect(initialCopy('a.md')).toMatchObject({ filename: 'a (copy).md', attachProjectId: '' });
  });

  it('sends the name as typed without its spaces, and the project only when one is chosen', () => {
    const named = copyReducer(initialCopy('a.txt'), { type: 'named', filename: '  mine.txt ' });
    const state = copyReducer(named, { type: 'projectChosen', projectId: 'p1' });
    expect(copyRequest(state)).toEqual({ filename: 'mine.txt', attachProjectId: 'p1' });
    expect(copyRequest({ ...state, filename: '   ', attachProjectId: '' })).toEqual({
      filename: undefined,
      attachProjectId: null,
    });
  });

  it('a copy that is not made says so', () => {
    const sent = copyReducer(initialCopy('a.txt'), { type: 'sent' });
    expect(copyReducer(sent, { type: 'failed', error: null })).toMatchObject({
      busy: false,
      error: 'The copy could not be made.',
    });
    expect(copyReducer(sent, { type: 'failed', error: 'Over quota' }).error).toBe('Over quota');
  });
});

describe('rename', () => {
  it('starts on the current name and sends the new one without its spaces', () => {
    const state = renameReducer(initialRename('schema-guide.md'), {
      type: 'named',
      filename: ' postgres-schema-guide.md ',
    });
    expect(initialRename('schema-guide.md').filename).toBe('schema-guide.md');
    expect(renameRequest(state)).toBe('postgres-schema-guide.md');
  });

  it('a refused rename says why and can be tried again', () => {
    const sent = renameReducer(initialRename('a.md'), { type: 'sent' });
    const refused = renameReducer(sent, { type: 'failed', error: 'Name taken' });
    expect(refused).toMatchObject({ busy: false, error: 'Name taken' });
  });
});
