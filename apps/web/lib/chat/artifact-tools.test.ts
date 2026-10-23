/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for fakes that never touch it */
/**
 * artifact_search ranks windows of a file's text by the query's terms:
 * a window holding more distinct terms wins, the exact phrase adds, and
 * overlapping windows collapse to the better one. The tool itself opens
 * the files through the store, mocked here, and reports where each
 * passage sits so a read can carry on from it.
 */

jest.mock('./attachments', () => ({
  listAttachments: jest.fn(),
  listProjectArtifacts: jest.fn(),
  getAttachmentText: jest.fn(),
}));
jest.mock('./artifact-access', () => ({ resolveArtifactAccess: jest.fn() }));
jest.mock('./artifact-library', () => ({ attachToProject: jest.fn(), shareArtifact: jest.fn() }));

import { getAttachmentText, listAttachments, listProjectArtifacts } from './attachments';
import { resolveArtifactAccess } from './artifact-access';
import { attachToProject } from './artifact-library';
import { artifactTools, scoreText, termsOf } from './artifact-tools';
import { createLocalToolSet, type LocalToolContext } from './local-tools';
import { resourceCipher } from './content-crypto';

const listMock = jest.mocked(listAttachments);
const listProjectMock = jest.mocked(listProjectArtifacts);
const textMock = jest.mocked(getAttachmentText);
const accessMock = jest.mocked(resolveArtifactAccess);
const attachMock = jest.mocked(attachToProject);

const cipher = resourceCipher({
  id: '00000000-0000-4000-8000-00000000c1fe',
  key: Buffer.alloc(32, 7),
});

function context(extra: Partial<LocalToolContext> = {}): LocalToolContext {
  return {
    db: null as unknown as LocalToolContext['db'],
    subject: 'auth0|alice',
    chatId: 'chat-1',
    cipher,
    projectId: 'proj-1',
    readOnly: false,
    ...extra,
  };
}

const row = (id: string, filename: string, over: Record<string, unknown> = {}) => ({
  id,
  ownerSubject: 'auth0|alice',
  chatId: null,
  messageId: null,
  blobKey: `blob/${id}`,
  filename,
  contentType: 'text/plain',
  sizeBytes: 10,
  extractStatus: 'done',
  origin: 'upload',
  keyKind: 'artifact' as const,
  keyRef: null,
  summary: null,
  keywords: [],
  digestStatus: 'none',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  referenceId: `ref-${id}`,
  mode: 'on_demand' as const,
  addedBy: 'auth0|alice',
  ...over,
});

describe('termsOf', () => {
  it('lower-cases, splits on punctuation and drops one-letter words', () => {
    expect(termsOf('Money rounding: numeric(12,4) a refund')).toEqual([
      'money',
      'rounding',
      'numeric',
      '12',
      'refund',
    ]);
  });
});

describe('scoreText', () => {
  it('ranks the window with more of the terms first and collapses overlaps', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(60);
    const text = `${filler}rounding happens at the boundary, half to even, never in storage.${filler}${filler}money columns are numeric.${filler}`;
    const hits = scoreText(text, termsOf('rounding money numeric'), 'rounding money numeric');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // The first passage mentions rounding only; the later one money and numeric.
    expect(hits[0].offset).toBeGreaterThan(hits[1].offset);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    for (const [i, hit] of hits.entries()) {
      for (const other of hits.slice(i + 1)) {
        expect(Math.abs(hit.offset - other.offset)).toBeGreaterThanOrEqual(1_200);
      }
    }
  });

  it('returns nothing when no term appears', () => {
    expect(scoreText('nothing to see', termsOf('rounding'), 'rounding')).toEqual([]);
  });
});

describe('artifact_search', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    listMock.mockResolvedValue([]);
    accessMock.mockResolvedValue({ cipher } as never);
  });

  it('searches the project’s on-demand artifacts and reports file and offset', async () => {
    listProjectMock.mockResolvedValue([
      row('a1', 'guide.pdf'),
      row('a2', 'always.md', { mode: 'always' }),
    ]);
    textMock.mockImplementation(async (_db, id) =>
      id === 'a1' ? 'Intro. Monetary columns are numeric(12,4); round half to even.' : 'never read'
    );
    const tools = createLocalToolSet(artifactTools({ inProject: true }));
    const result = await tools.run('artifact_search', { query: 'round half even' }, context());
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('guide.pdf (artifact id a1, offset 0)');
    expect(text).toContain('round half to even');
    expect(text).not.toContain('always.md');
    expect(textMock).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing matches', async () => {
    listProjectMock.mockResolvedValue([row('a1', 'guide.pdf')]);
    textMock.mockResolvedValue('Nothing relevant here.');
    const tools = createLocalToolSet(artifactTools({ inProject: true }));
    const result = await tools.run('artifact_search', { query: 'rounding' }, context());
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('Nothing in 1 file(s) matched');
  });
});

describe('artifact_attach', () => {
  it('refuses under read-only mode and outside a project', async () => {
    const tools = createLocalToolSet(artifactTools({ inProject: true }));
    const readOnly = await tools.run(
      'artifact_attach',
      { attachmentId: 'a1' },
      context({ readOnly: true })
    );
    expect(readOnly.isError).toBe(true);
    const none = await tools.run(
      'artifact_attach',
      { attachmentId: 'a1' },
      context({ projectId: null })
    );
    expect(none.isError).toBe(true);
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('attaches on demand by default and explains a budget refusal', async () => {
    attachMock.mockResolvedValueOnce({
      ok: true,
      val: { referenceId: 'r', mode: 'on_demand' },
    } as never);
    const tools = createLocalToolSet(artifactTools({ inProject: true }));
    const done = await tools.run('artifact_attach', { attachmentId: 'a1' }, context());
    expect(done.isError).toBeFalsy();
    expect(attachMock).toHaveBeenCalledWith(null, {
      actorSubject: 'auth0|alice',
      artifactId: 'a1',
      projectId: 'proj-1',
      mode: 'on_demand',
    });
    attachMock.mockResolvedValueOnce({ ok: false, err: { type: 'BUDGET' } } as never);
    const over = await tools.run(
      'artifact_attach',
      { attachmentId: 'a1', mode: 'always' },
      context()
    );
    expect(over.isError).toBe(true);
    expect(over.content.map((c) => ('text' in c ? c.text : '')).join('')).toContain('budget');
  });
});
