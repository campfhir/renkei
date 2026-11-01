/**
 * One page of a person's library (artifact-library-query.ts), on the
 * memory store: what the Artifacts page shows for each filter, search,
 * page and link. These were artifacts.spec.ts's filter tabs, its pages of
 * 25, its search by name and by digest, and its link opening to the page
 * a file sits on; the spec keeps the list drawn on the real server and
 * scrolling in its own box.
 *
 * Files are made the way the store makes them (artifacts.create, a share
 * through grantResourceAccess, a digest through storeDigest), a second
 * apart, so the order is the one people see.
 */

import { randomUUID } from 'node:crypto';
import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { grantResourceAccess } from './access';
import { queryLibrary } from './artifact-library-query';
import { parseLibraryQuery, type LibraryQuery } from './artifact-library-params';

const ME = 'me-subject';
const PRIYA = 'priya-subject';
const START = new Date('2026-11-01T09:00:00.000Z').getTime();

let clock = START;

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
  clock = START;
  jest.useFakeTimers({ now: START, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
  resetDataStore();
});

/** A file, a second after the last one. */
async function make(
  filename: string,
  more: { owner?: string; origin?: 'upload' | 'model'; chatId?: string | null } = {}
): Promise<string> {
  clock += 1000;
  jest.setSystemTime(clock);
  const id = randomUUID();
  await getDataStore().artifacts.create({
    id,
    ownerSubject: more.owner ?? ME,
    chatId: more.chatId ?? null,
    messageId: null,
    origin: more.origin ?? 'upload',
    keyKind: 'artifact',
    keyRef: null,
    blobKey: `blobs/${id}`,
    filename,
    contentType: 'text/markdown',
    sizeBytes: 100,
    extractedText: null,
    extractStatus: 'done',
    digestStatus: 'pending',
  });
  return id;
}

async function shareWithMe(id: string): Promise<void> {
  const outcome = await grantResourceAccess(PRIYA, 'artifact', id, {
    granteeSubject: ME,
    role: 'viewer',
    expiresAt: null,
  });
  expect(outcome).toBe('OK');
}

const ask = (params: Record<string, string> = {}): LibraryQuery => parseLibraryQuery(params);
const names = async (params: Record<string, string> = {}) =>
  (await queryLibrary(ME, ask(params))).artifacts.map((item) => item.filename);

/** The staged library of the spec: an upload, a generated file, a colleague's shared manual. */
async function library(): Promise<{ guide: string; report: string; manual: string }> {
  const guide = await make('schema-guide.md');
  const report = await make('rounding-analysis.md', { origin: 'model' });
  const manual = await make('vendor-sdk-manual.txt', { owner: PRIYA });
  await shareWithMe(manual);
  const store = getDataStore();
  await store.artifacts.storeDigest(guide, {
    summary: 'A Postgres schema guide: how monetary columns are typed and where rounding happens.',
    keywords: ['postgres', 'schema', 'rounding'],
  });
  await store.artifacts.storeDigest(manual, {
    summary: 'The vendor SDK manual: retries are exponential with jitter.',
    keywords: ['retries', 'jitter'],
  });
  return { guide, report, manual };
}

describe('what the library lists', () => {
  it('my own files newest first, then the ones shared with me, each saying how I hold it', async () => {
    await library();
    const page = await queryLibrary(ME, ask());
    expect(page.artifacts.map((item) => [item.filename, item.via])).toEqual([
      ['rounding-analysis.md', 'owner'],
      ['schema-guide.md', 'owner'],
      ['vendor-sdk-manual.txt', 'grant'],
    ]);
    expect(page).toMatchObject({ total: 3, libraryCount: 3, page: 1, pageCount: 1 });
    expect(page.owned).toEqual({ count: 2, bytes: 200 });
  });

  it('nobody else’s files, and nothing shared with someone else', async () => {
    const other = await make('their-notes.md', { owner: PRIYA });
    expect(other).toBeTruthy();
    expect(await names()).toEqual([]);
    expect((await queryLibrary(ME, ask())).libraryCount).toBe(0);
  });

  it('each tab narrows to its kind of file', async () => {
    await library();
    expect(await names({ show: 'uploaded' })).toEqual(['schema-guide.md']);
    expect(await names({ show: 'generated' })).toEqual(['rounding-analysis.md']);
    expect(await names({ show: 'shared' })).toEqual(['vendor-sdk-manual.txt']);
  });

  it('a project narrows to the files it holds', async () => {
    const { guide } = await library();
    const projectId = await getDataStore().chatProjects.create({
      ownerSubject: ME,
      name: 'Billing API',
      description: null,
      toolConfig: null,
    });
    await getDataStore().artifacts.addReference({
      artifactId: guide,
      projectId,
      mode: 'on_demand',
      addedBy: ME,
    });
    expect(await names({ project: projectId })).toEqual(['schema-guide.md']);
  });
});

describe('search', () => {
  it('finds a word in a name, as part of it', async () => {
    await library();
    expect(await names({ q: 'analysis' })).toEqual(['rounding-analysis.md']);
    expect(await names({ q: 'SDK' })).toEqual(['vendor-sdk-manual.txt']);
  });

  it('finds a file by what the model wrote about it', async () => {
    await library();
    expect(await names({ q: 'jitter' })).toEqual(['vendor-sdk-manual.txt']);
    expect(await names({ q: 'monetary rounding' })).toEqual(['schema-guide.md']);
    // "rounding" is in one name and one digest: both are found, owned first.
    expect(await names({ q: 'rounding' })).toEqual(['rounding-analysis.md', 'schema-guide.md']);
  });

  it('finding nothing still knows the library is not empty', async () => {
    await library();
    const page = await queryLibrary(ME, ask({ q: 'zzzz-nothing' }));
    expect(page.artifacts).toEqual([]);
    expect(page).toMatchObject({ total: 0, libraryCount: 3, pageCount: 1 });
  });
});

describe('pages of 25', () => {
  /** Thirty older uploads, then the spec's library: thirty-two of mine and one shared. */
  async function backlog(): Promise<Record<number, string>> {
    const ids: Record<number, string> = {};
    for (let n = 30; n >= 1; n -= 1) {
      ids[n] = await make(`backlog-${String(n).padStart(2, '0')}.txt`);
    }
    await library();
    return ids;
  }

  it('the first page holds 25, newest first, and says how many pages there are', async () => {
    await backlog();
    const page = await queryLibrary(ME, ask());
    expect(page).toMatchObject({ total: 33, page: 1, pageCount: 2, pageSize: 25 });
    expect(page.artifacts).toHaveLength(25);
    expect(page.artifacts.at(-1)?.filename).toBe('backlog-23.txt');
  });

  it('the second page holds the oldest of mine and then the shared one', async () => {
    await backlog();
    const page = await queryLibrary(ME, ask({ page: '2' }));
    expect(page.page).toBe(2);
    expect(page.artifacts.map((item) => item.filename)).toEqual([
      ...Array.from({ length: 7 }, (_, i) => `backlog-${24 + i}.txt`),
      'vendor-sdk-manual.txt',
    ]);
  });

  it('a page past the end shows the last one', async () => {
    await backlog();
    expect((await queryLibrary(ME, ask({ page: '9' }))).page).toBe(2);
  });

  it('a search starts over on its own pages', async () => {
    await backlog();
    const page = await queryLibrary(ME, ask({ q: 'backlog-2' }));
    expect(page).toMatchObject({ total: 10, pageCount: 1, page: 1 });
  });

  it('a link to one file opens to the page it is on', async () => {
    const ids = await backlog();
    const page = await queryLibrary(ME, ask({ artifact: ids[30] }));
    expect(page.page).toBe(2);
    expect(page.artifacts.some((item) => item.id === ids[30])).toBe(true);
    // A newer one stays on the first page.
    expect((await queryLibrary(ME, ask({ artifact: ids[1] }))).page).toBe(1);
  });

  it('a link that also names a later page opens that page; page 1 is the default and follows the link', async () => {
    const ids = await backlog();
    expect((await queryLibrary(ME, ask({ artifact: ids[1], page: '2' }))).page).toBe(2);
    expect((await queryLibrary(ME, ask({ artifact: ids[30], page: '1' }))).page).toBe(2);
  });
});
