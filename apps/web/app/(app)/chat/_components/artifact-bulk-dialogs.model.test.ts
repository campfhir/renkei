/**
 * Acting on several library files at once (artifact-bulk-dialogs.model.ts),
 * as the person ticking them would describe it. artifacts.spec.ts walked
 * "several files ticked, deleted with the impact warned, or added to a
 * project" by pressing; the rules are here. Each file goes out as the
 * one-file attach or delete does, which the spec and the route tests
 * already cover.
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

  it('a partial failure says how many of how many, and a retry sends only the ones that failed', () => {
    const items = [item('a'), item('b'), item('c')];
    const actions: BulkAddAction[] = [
      { type: 'sent' },
      {
        type: 'answered',
        projectId: 'billing',
        outcomes: [
          { id: 'a', error: null },
          { id: 'b', error: 'Over the budget' },
          { id: 'c', error: null },
        ],
      },
    ];
    const answered = actions.reduce(bulkAddReducer, initialBulkAdd(projects));
    expect(answered.error).toBe('1 of 3 could not be added: Over the budget');
    const view = bulkAddView(answered, items, projects);
    expect(view.toAdd.map((file) => file.id)).toEqual(['b']);
    expect(view.label).toBe('Add 1');
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

  it('after a partial failure, a second Delete never removes the same file twice', () => {
    const items = [owned, shared, item('report')];
    const actions: BulkDeleteAction[] = [
      { type: 'impactsLoaded', impacts: { guide: impact(), report: impact() } },
      { type: 'sent' },
      {
        type: 'answered',
        outcomes: [
          { id: 'guide', error: null },
          { id: 'manual', error: 'No such file' },
          { id: 'report', error: null },
        ],
      },
    ];
    const answered = actions.reduce(bulkDeleteReducer, initialBulkDelete);
    expect(answered.error).toBe('1 of 3 could not be removed: No such file');
    // The page behind has not caught up yet: the dialog still holds all three.
    const view = bulkDeleteView(answered, items);
    expect(view.toRemove).toEqual(['manual']);
    expect(view.label).toBe('Delete 1');
    const retried = bulkDeleteReducer(answered, {
      type: 'answered',
      outcomes: [{ id: 'manual', error: null }],
    });
    expect(retried.error).toBeNull();
    expect(bulkDeleteView(retried, items)).toMatchObject({ toRemove: [], disabled: true });
  });
});
