/**
 * The Artifacts page (artifacts-index.model.ts), as a person using the
 * library would describe it. artifacts.spec.ts walked these by pressing:
 * the filters, the details panel and what it says about who may do
 * what, a keyword as a search, select mode and its toolbar, the pager,
 * the empty states. What the server answers for a filter, a search, a
 * page or a link to one file is lib/chat/artifact-library-query.test.ts.
 * The spec keeps the page on the real server, the list scrolling in its
 * own box, the phone layout, and one real upload end to end.
 */

import type { LibraryItem } from '@/lib/chat/artifact-library';
import type { LibraryQuery } from '@/lib/chat/artifact-library-params';
import {
  accessLine,
  acts,
  canAttach,
  clampPage,
  currentItem,
  detachSends,
  digestLabel,
  emptyMessage,
  failureLine,
  filterStep,
  filtersOf,
  indexReducer,
  initialIndex,
  keepsReading,
  keyOf,
  originWord,
  ownerLabel,
  pager,
  pickedItems,
  rowOrigin,
  rowPress,
  rowProjects,
  seenReading,
  showsAbout,
  toolbar,
  usedInNowhere,
  type IndexAction,
  type IndexState,
} from './artifacts-index.model';

const QUERY: LibraryQuery = { show: 'all', projectId: null, query: '', page: 1, focus: null };

const file = (id: string, more: Partial<LibraryItem> = {}): LibraryItem => ({
  id,
  filename: `${id}.md`,
  contentType: 'text/markdown',
  sizeBytes: 1200,
  extractStatus: 'done',
  origin: 'upload',
  ownerSubject: 'me',
  ownerName: null,
  via: 'owner',
  chat: null,
  projects: [],
  sharedWith: 0,
  summary: null,
  keywords: [],
  digestStatus: 'done',
  ocrSupported: false,
  ocr: null,
  ocrPages: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...more,
});

const running = {
  startedAt: '2026-11-01T10:00:00.000Z',
  elapsedMs: 1000,
  stalled: false,
  estimate: { remainingMs: null, totalMs: null, basedOn: 0, overdue: false },
};

const start = (items: LibraryItem[] = [], selectedId: string | null = null) =>
  initialIndex({ query: QUERY, items, selectedId });
const run = (actions: IndexAction[], from: IndexState = start()) =>
  actions.reduce(indexReducer, from);

describe('the filters', () => {
  it('start from what the URL asked for', () => {
    const state = initialIndex({
      query: { ...QUERY, show: 'shared', query: 'jitter' },
      items: [],
      selectedId: null,
    });
    expect(state.filters).toEqual({ show: 'shared', projectId: null, query: 'jitter' });
  });

  it('a tab or a project asks for its first page at once; typing in search waits for a pause', () => {
    const state = start();
    expect(filterStep(state, { show: 'generated' })).toEqual({
      filters: { show: 'generated', projectId: null, query: '' },
      page: 1,
      debounce: false,
    });
    expect(filterStep(state, { projectId: 'p1' }).debounce).toBe(false);
    expect(filterStep(state, { query: 'roun' })).toMatchObject({ page: 1, debounce: true });
  });

  it('what is typed builds on the other filters, and the back button puts back what the URL says', () => {
    const typed = run([
      { type: 'filtered', patch: { show: 'uploaded' } },
      { type: 'filtered', patch: { query: 'invoice' } },
    ]);
    expect(typed.filters).toEqual({ show: 'uploaded', projectId: null, query: 'invoice' });
    const back = run([{ type: 'urlChanged', filters: filtersOf(QUERY) }], typed);
    expect(back.filters).toEqual(filtersOf(QUERY));
  });

  it('tells two sets of filters apart by every part of them', () => {
    const base = filtersOf(QUERY);
    expect(keyOf(base)).toBe(keyOf({ ...base }));
    expect(keyOf(base)).not.toBe(keyOf({ ...base, show: 'shared' }));
    expect(keyOf(base)).not.toBe(keyOf({ ...base, projectId: 'p1' }));
    expect(keyOf(base)).not.toBe(keyOf({ ...base, query: 'x' }));
  });
});

describe('the details', () => {
  const guide = file('guide');
  const report = file('report');

  it('a press on a row opens its details; on a wide screen a second press closes them', () => {
    const open = run([rowPress(start([guide]), guide, false)], start([guide]));
    expect(open.selected).toBe('guide');
    expect(currentItem(open, [guide])).toBe(guide);
    const closed = run([rowPress(open, guide, false)], open);
    expect(closed.selected).toBeNull();
  });

  it('on a phone a row only ever opens: the details cover the list', () => {
    const open = run([{ type: 'selected', item: guide }]);
    expect(rowPress(open, guide, true)).toEqual({ type: 'selected', item: guide });
  });

  it('a link to a file opens its details as the page draws', () => {
    expect(currentItem(start([guide, report], 'report'), [guide, report])).toBe(report);
  });

  it('stay open while a page without the file is shown, and follow it when it is back', () => {
    const open = run([{ type: 'selected', item: guide }]);
    expect(currentItem(open, [report])).toBe(guide);
    const renamed = { ...guide, filename: 'postgres-guide.md' };
    const seen = run([{ type: 'seenOnPage', item: renamed }], open);
    expect(currentItem(seen, [report])?.filename).toBe('postgres-guide.md');
  });

  it('a copy just made is opened once its page arrives', () => {
    const revealed = run(
      [{ type: 'revealed', id: 'copy-1' }],
      run([{ type: 'selected', item: guide }])
    );
    expect(currentItem(revealed, [guide])).toBeNull();
    const copy = file('copy-1');
    expect(currentItem(revealed, [copy, guide])).toBe(copy);
  });

  it('say where the file came from and whose it is', () => {
    expect(originWord(file('a', { origin: 'model' }))).toBe('generated');
    expect(originWord(guide)).toBe('uploaded');
    expect(ownerLabel(guide)).toBe('owned by you');
    expect(ownerLabel(file('m', { via: 'grant', ownerName: 'Priya Friend' }))).toBe(
      'Priya Friend’s'
    );
    expect(ownerLabel(file('m', { via: 'project' }))).toBe('someone’s');
  });

  it('say where it is used when no project holds it', () => {
    expect(usedInNowhere(guide)).toBe('Not attached to a project.');
    expect(usedInNowhere(file('csv', { chat: { id: 'c', title: 'March', projectId: null } }))).toBe(
      'In its chat only; it goes when the chat does unless a project takes it.'
    );
  });

  it('show what the model wrote about it, or where its summary has got to', () => {
    expect(showsAbout(guide, true)).toBe(true);
    expect(showsAbout(guide, false)).toBe(false);
    expect(showsAbout(file('a', { summary: 'A guide' }), false)).toBe(true);
    expect(showsAbout(file('a', { keywords: ['postgres'] }), false)).toBe(true);
    expect(digestLabel(file('a', { digestStatus: 'pending' }))).toBe('Summary on its way…');
    expect(digestLabel(file('a', { digestStatus: 'running', contentType: 'image/png' }))).toBe(
      'Describing the picture…'
    );
    expect(digestLabel(file('a', { digestStatus: 'failed' }))).toBe(
      'No summary could be written for this file.'
    );
    expect(digestLabel(file('a', { digestStatus: 'none', contentType: 'image/jpeg' }))).toBe(
      'Nothing to describe.'
    );
    expect(digestLabel(guide)).toBeNull();
  });
});

describe('who may do what', () => {
  it('the owner shares, replaces, renames and deletes', () => {
    const mine = file('guide');
    expect(acts(mine)).toMatchObject({ owner: true, copy: false, leave: false });
    expect(acts(mine).note).toMatch(/^Replacing keeps every attachment/);
  });

  it('a colleague’s shared file is copied or taken off the list, never changed', () => {
    const theirs = file('manual', { via: 'grant', ownerName: 'Priya Friend' });
    expect(acts(theirs)).toMatchObject({ owner: false, copy: true, leave: true });
    expect(acts(theirs).note).toMatch(/^A copy is a separate file you own/);
  });

  it('a file read through a project can be copied, but not left: it is not on the list by a share', () => {
    expect(acts(file('p', { via: 'project' }))).toMatchObject({
      owner: false,
      copy: true,
      leave: false,
    });
  });

  it('says who owns it, who it is shared with, and who else reads it', () => {
    expect(accessLine(file('a'))).toBe('You own it. ');
    expect(
      accessLine(
        file('a', {
          sharedWith: 1,
          projects: [{ id: 'p', name: 'Billing', kind: 'chat', mode: 'on_demand' }],
        })
      )
    ).toBe(
      'You own it; shared with 1 person. Everyone in the projects above reads it; their owners and editors may detach it.'
    );
    expect(accessLine(file('a', { sharedWith: 2 }))).toBe('You own it; shared with 2 people. ');
    expect(accessLine(file('a', { via: 'grant' }))).toMatch(/^Shared with you: use it/);
    expect(accessLine(file('a', { via: 'chat' }))).toBe(
      'You read it through a project or chat it is used in.'
    );
  });

  it('offers to attach it to a project only to an owner or a person it was shared with, who has one', () => {
    expect(canAttach(file('a'), 1)).toBe(true);
    expect(canAttach(file('a', { via: 'grant' }), 1)).toBe(true);
    expect(canAttach(file('a', { via: 'project' }), 1)).toBe(false);
    expect(canAttach(file('a'), 0)).toBe(false);
  });
});

describe('the rows', () => {
  it('say where each file came from, and whose it is when it is someone else’s', () => {
    const chat = { id: 'c1', title: 'Fix invoice rounding', projectId: 'p' };
    expect(rowOrigin(file('r', { origin: 'model', chat }))).toBe(
      ' · generated in “Fix invoice rounding”'
    );
    expect(rowOrigin(file('csv', { chat: { ...chat, title: 'Reconcile March invoices' } }))).toBe(
      ' · uploaded in “Reconcile March invoices”'
    );
    expect(rowOrigin(file('u', { chat: { ...chat, title: null } }))).toBe(
      ' · uploaded in “a chat”'
    );
    expect(rowOrigin(file('m', { ownerName: 'Priya Friend' }))).toBe(' · shared by Priya Friend');
    expect(rowOrigin(file('plain'))).toBe('');
  });

  it('name two projects at most, and how many more', () => {
    expect(rowProjects(['a', 'b', 'c', 'd'])).toEqual({ named: ['a', 'b'], more: 2 });
    expect(rowProjects(['a'])).toEqual({ named: ['a'], more: 0 });
  });
});

describe('select mode', () => {
  const a = file('a');
  const b = file('b', { ocrSupported: true, contentType: 'application/pdf' });
  const c = file('c', { ocrSupported: true, ocr: running });

  it('a press on a row ticks it and leaves the details alone', () => {
    const selecting = run([{ type: 'selectModeToggled' }], start([a]));
    const ticked = run([rowPress(selecting, a, false)], selecting);
    expect(ticked.picked).toEqual(['a']);
    expect(ticked.selected).toBeNull();
    expect(run([rowPress(ticked, a, false)], ticked).picked).toEqual([]);
  });

  it('the toolbar counts what is ticked, and its acts are off until something is', () => {
    const selecting = run([{ type: 'selectModeToggled' }]);
    expect(toolbar(selecting, [a, b])).toEqual({
      label: 'Tap files to select',
      anyPicked: false,
      ocrTargets: [],
    });
    const two = run(
      [
        { type: 'pickToggled', id: 'a' },
        { type: 'pickToggled', id: 'b' },
      ],
      selecting
    );
    expect(toolbar(two, [a, b])).toMatchObject({ label: '2 selected', anyPicked: true });
  });

  it('Run OCR asks only for the ticked files it can read and that are not being read', () => {
    const all = run([{ type: 'pickedAll', ids: ['a', 'b', 'c'] }]);
    expect(toolbar(all, [a, b, c]).ocrTargets).toEqual([b]);
  });

  it('select all ticks the page; clear and leaving select mode untick everything', () => {
    const all = run([{ type: 'pickedAll', ids: ['a', 'b'] }]);
    expect(pickedItems(all, [a, b])).toEqual([a, b]);
    expect(run([{ type: 'pickCleared' }], all).picked).toEqual([]);
    const on = run([{ type: 'selectModeToggled' }], all);
    expect(on.selecting).toBe(true);
    expect(on.picked).toEqual([]);
  });

  it('only ticked files on this page are acted on', () => {
    const state = run([{ type: 'pickedAll', ids: ['a', 'gone'] }]);
    expect(pickedItems(state, [a, b])).toEqual([a]);
  });

  it('opens and closes the bulk dialogs', () => {
    const open = run([{ type: 'bulkOpened', bulk: 'delete' }]);
    expect(open.bulk).toBe('delete');
    expect(run([{ type: 'bulkClosed' }], open).bulk).toBeNull();
  });
});

describe('the pager', () => {
  it('says which rows of how many, and holds Previous on the first page', () => {
    expect(pager({ total: 34, page: 1, pageSize: 25, pageCount: 2 })).toEqual({
      range: '1–25 of 34',
      pageLabel: 'Page 1 of 2',
      previousDisabled: true,
      nextDisabled: false,
    });
  });

  it('the last page holds Next and shows only what is left', () => {
    expect(pager({ total: 34, page: 2, pageSize: 25, pageCount: 2 })).toMatchObject({
      range: '26–34 of 34',
      nextDisabled: true,
      previousDisabled: false,
    });
  });

  it('one page: no buttons; nothing matching: no pager at all', () => {
    expect(pager({ total: 10, page: 1, pageSize: 25, pageCount: 1 })).toMatchObject({
      range: '1–10 of 10',
      pageLabel: null,
    });
    expect(pager({ total: 0, page: 1, pageSize: 25, pageCount: 1 }).range).toBeNull();
  });

  it('never asks for a page that is not there', () => {
    expect(clampPage({ pageCount: 2 }, 3)).toBe(2);
    expect(clampPage({ pageCount: 2 }, 0)).toBe(1);
  });
});

describe('an empty list', () => {
  it('invites a first upload when the library is empty', () => {
    expect(emptyMessage(0, '', true)).toMatch(/^No artifacts yet\./);
  });

  it('says nothing matches, and where search looks when summaries are on', () => {
    expect(emptyMessage(5, 'zzzz-nothing', true)).toBe(
      'Nothing matches. Search looks at file names and at the summary and keywords written for each file.'
    );
    expect(emptyMessage(5, 'zzzz', false)).toBe('Nothing matches.');
    expect(emptyMessage(5, '  ', true)).toBe('Nothing matches.');
  });
});

describe('acts and their errors', () => {
  it('an act clears the error line, and a refusal puts its reason there', () => {
    const failed = run([{ type: 'actSent' }, { type: 'actAnswered', error: 'Not yours' }]);
    expect(failed.error).toBe('Not yours');
    expect(run([{ type: 'actSent' }], failed).error).toBeNull();
    expect(run([{ type: 'actAnswered', error: null }], failed).error).toBe('Not yours');
  });

  it('names every file that failed in one line', () => {
    expect(failureLine(['a.pdf: Too big', 'b.png: Not allowed'])).toBe(
      'a.pdf: Too big; b.png: Not allowed'
    );
    expect(failureLine([])).toBeNull();
  });

  it('an upload shows which file of how many, its bytes moving, and goes when all are answered', () => {
    const moving = run([
      { type: 'actSent' },
      {
        type: 'transferMoved',
        transfer: { count: 2, index: 1, name: 'a.md', loaded: 0, bytes: 300 },
      },
      { type: 'transferProgress', loaded: 120 },
    ]);
    expect(moving.transfer).toEqual({ count: 2, index: 1, name: 'a.md', loaded: 120, bytes: 300 });
    const done = run([{ type: 'uploadsAnswered', failures: ['b.md: Too large'] }], moving);
    expect(done.transfer).toBeNull();
    expect(done.error).toBe('b.md: Too large');
    expect(run([{ type: 'transferProgress', loaded: 5 }], done).transfer).toBeNull();
  });

  it('a second press on a detach in flight sends nothing; a refusal lets it be pressed again', () => {
    const sent = run([{ type: 'detachSent', key: 'guide:billing' }]);
    expect(detachSends(sent, 'guide:billing')).toBe(false);
    expect(detachSends(sent, 'guide:docs')).toBe(true);
    const refused = run([{ type: 'detachFailed', error: 'Only editors detach' }], sent);
    expect(refused.error).toBe('Only editors detach');
    expect(detachSends(refused, 'guide:billing')).toBe(true);
    expect(run([{ type: 'pageArrived' }], sent).detaching).toBeNull();
  });

  it('a drag shows the drop target only where uploads are possible', () => {
    expect(run([{ type: 'dragEntered', uploads: false }]).dragging).toBe(false);
    const over = run([{ type: 'dragEntered', uploads: true }]);
    expect(over.dragging).toBe(true);
    expect(run([{ type: 'dragEnded' }], over).dragging).toBe(false);
  });

  it('opens one dialog at a time', () => {
    const open = run([{ type: 'dialogOpened', dialog: 'rename' }]);
    expect(open.dialog).toBe('rename');
    expect(run([{ type: 'dialogClosed' }], open).dialog).toBeNull();
  });
});

describe('reading the page again', () => {
  it('while a read is in flight', () => {
    expect(keepsReading([file('a', { ocr: running })], false, new Set())).toBe(true);
    expect(keepsReading([file('a')], true, new Set())).toBe(false);
  });

  it('until the summary lands for a file this page saw being read', () => {
    const seen = seenReading(new Set(), [file('scan', { ocr: running })]);
    const summarizing = [file('scan', { digestStatus: 'running' })];
    expect(keepsReading(summarizing, true, seen)).toBe(true);
    expect(keepsReading(summarizing, false, seen)).toBe(false);
    expect(keepsReading([file('scan', { digestStatus: 'done' })], true, seen)).toBe(false);
    // A summary pending for a file never read here does not keep the page reading.
    expect(keepsReading([file('other', { digestStatus: 'pending' })], true, seen)).toBe(false);
  });

  it('remembers every file it saw being read, and only adds to that', () => {
    const first = seenReading(new Set(['old']), [file('a', { ocr: running }), file('b')]);
    expect([...first].sort()).toEqual(['a', 'old']);
  });
});
