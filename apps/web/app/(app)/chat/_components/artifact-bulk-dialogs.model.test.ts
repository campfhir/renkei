/**
 * Acting on several library files at once (artifact-bulk-dialogs.model.ts),
 * as the person ticking them would describe it. artifacts.spec.ts walked
 * "several files ticked, deleted with the impact warned, or added to a
 * project" by pressing; the rules are here. Confirming sends one request
 * the server takes as a job (lib/chat/artifact-bulk-job.test.ts), so the
 * dialog only waits for it to be taken.
 */

import type { ArtifactImpact, LibraryItem } from '@/lib/chat/artifact-library';
import {
  bulkAddReducer,
  bulkAddTitle,
  bulkAddView,
  bulkDeleteReducer,
  bulkDeleteTitle,
  bulkDeleteView,
  deleteSummary,
  deleteWarnings,
  initialBulkAdd,
  initialBulkDelete,
  splitByOwner,
  type BulkAddAction,
  type BulkDeleteAction,
} from './artifact-bulk-dialogs.model';

type Item = Pick<LibraryItem, 'id' | 'filename' | 'via' | 'projects'>;

const item = (id: string, more: Partial<Item> = {}): Item => ({
  id,
  filename: `${id}.md`,
  via: 'owner',
  projects: [],
  ...more,
});
const inBilling = { id: 'billing', name: 'Billing API', kind: 'chat', mode: 'on_demand' as const };
const projects = [
  { id: 'billing', name: 'Billing API', kind: 'chat' },
  { id: 'docs', name: 'Docs', kind: 'chat' },
];

const impact = (more: Partial<ArtifactImpact> = {}): ArtifactImpact => ({
  projects: [],
  sharedWith: [],
  chat: null,
  ...more,
});

describe('add to a project', () => {
  it('starts on the first project, On demand', () => {
    expect(initialBulkAdd(projects)).toMatchObject({ projectId: 'billing', mode: 'on_demand' });
    expect(initialBulkAdd([]).projectId).toBe('');
    expect(bulkAddTitle(1)).toBe('Add 1 file to a project');
    expect(bulkAddTitle(2)).toBe('Add 2 files to a project');
  });

  it('adds only the files the project does not hold yet, and says how many it skips', () => {
    const items = [item('guide', { projects: [inBilling] }), item('report')];
    const view = bulkAddView(initialBulkAdd(projects), items, projects);
    expect(view.toAdd.map((file) => file.id)).toEqual(['report']);
    expect(view.summary).toBe('1 already in Billing API; 1 will be added.');
    expect(view.label).toBe('Add 1');
    expect(view.disabled).toBe(false);
  });

  it('another project holds none of them: all will be added', () => {
    const items = [item('guide', { projects: [inBilling] }), item('report')];
    const state = bulkAddReducer(initialBulkAdd(projects), {
      type: 'projectChosen',
      projectId: 'docs',
    });
    expect(bulkAddView(state, items, projects)).toMatchObject({
      summary: '2 will be added.',
      label: 'Add 2',
    });
  });

  it('is off with nothing left to add, with no project, and while it works', () => {
    const held = [item('guide', { projects: [inBilling] })];
    expect(bulkAddView(initialBulkAdd(projects), held, projects).disabled).toBe(true);
    expect(bulkAddView(initialBulkAdd([]), [item('a')], []).disabled).toBe(true);
    const busy = bulkAddReducer(initialBulkAdd(projects), { type: 'sent' });
    expect(bulkAddView(busy, [item('a')], projects).disabled).toBe(true);
  });

  it('works while the request goes out; a refusal keeps the dialog open with why, ready to retry', () => {
    const items = [item('a'), item('b')];
    const sent = bulkAddReducer(initialBulkAdd(projects), { type: 'sent' });
    expect(bulkAddView(sent, items, projects).disabled).toBe(true);
    const actions: BulkAddAction[] = [{ type: 'answered', error: 'No such project' }];
    const refused = actions.reduce(bulkAddReducer, sent);
    expect(refused.error).toBe('No such project');
    expect(bulkAddView(refused, items, projects)).toMatchObject({
      label: 'Add 2',
      disabled: false,
    });
    expect(bulkAddReducer(refused, { type: 'sent' }).error).toBeNull();
  });

  it('the how-it-is-used choice is kept for the request', () => {
    expect(
      bulkAddReducer(initialBulkAdd(projects), { type: 'modeChosen', mode: 'always' }).mode
    ).toBe('always');
  });
});

describe('delete several', () => {
  const owned = item('guide');
  const shared = item('manual', { via: 'grant' });

  it('cannot be confirmed while it works out who uses the owned files', () => {
    const view = bulkDeleteView(initialBulkDelete, [owned, shared]);
    expect(view.loading).toBe(true);
    expect(view.disabled).toBe(true);
    // Only shared files: nothing to work out.
    expect(bulkDeleteView(initialBulkDelete, [shared]).loading).toBe(false);
  });

  it('warns which owned files others lose, and who', () => {
    const impacts = {
      guide: impact({
        projects: [
          { id: 'billing', name: 'Billing API', kind: 'chat', members: 2, mode: 'always' },
        ],
        sharedWith: [{ subject: 'p', name: 'Priya', email: null }],
      }),
      lonely: impact(),
    };
    const items = [owned, item('lonely'), shared];
    expect(deleteWarnings(items, impacts)).toEqual([
      { id: 'guide', line: 'guide.md: Billing API, Priya' },
    ]);
    expect(deleteWarnings(items, null)).toEqual([]);
  });

  it('says what happens to each kind: yours removed for good, shared ones leave your list', () => {
    expect(splitByOwner([owned, shared])).toEqual({ owned: [owned], left: [shared] });
    expect(deleteSummary([owned, item('b')])).toBe(
      '2 files are yours and will be removed for good.'
    );
    expect(deleteSummary([shared])).toBe('1 shared with you leaves your list; the owner keeps it.');
    expect(deleteSummary([owned, shared, item('m2', { via: 'grant' })])).toBe(
      '1 file is yours and will be removed for good. 2 shared with you leave your list; the owner keeps them.'
    );
    expect(bulkDeleteTitle(2)).toBe('Delete 2 files?');
    expect(bulkDeleteTitle(1)).toBe('Delete 1 file?');
  });

  it('once the impact is in, Delete sends every file', () => {
    const state = bulkDeleteReducer(initialBulkDelete, {
      type: 'impactsLoaded',
      impacts: { guide: impact() },
    });
    expect(bulkDeleteView(state, [owned, shared])).toEqual({
      loading: false,
      toRemove: ['guide', 'manual'],
      label: 'Delete 2',
      disabled: false,
    });
  });

  it('works while the request goes out; a refusal keeps the dialog open with why, ready to retry', () => {
    const items = [owned, shared];
    const actions: BulkDeleteAction[] = [
      { type: 'impactsLoaded', impacts: { guide: impact() } },
      { type: 'sent' },
    ];
    const sent = actions.reduce(bulkDeleteReducer, initialBulkDelete);
    expect(bulkDeleteView(sent, items).disabled).toBe(true);
    const refused = bulkDeleteReducer(sent, { type: 'answered', error: 'Not signed in' });
    expect(refused.error).toBe('Not signed in');
    expect(bulkDeleteView(refused, items)).toMatchObject({
      toRemove: ['guide', 'manual'],
      disabled: false,
    });
  });
});
