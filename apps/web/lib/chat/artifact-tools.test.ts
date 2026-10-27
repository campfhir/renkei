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
  findChatAttachment: jest.fn(),
}));
jest.mock('./artifact-access', () => ({ resolveArtifactAccess: jest.fn() }));
jest.mock('./artifact-library', () => ({
  artifactImpact: jest.fn(),
  attachToProject: jest.fn(),
  deleteArtifact: jest.fn(),
  renameArtifact: jest.fn(),
  shareArtifact: jest.fn(),
}));
jest.mock('./artifact-digest', () => ({ storeDigest: jest.fn() }));

import {
  findChatAttachment,
  getAttachmentText,
  listAttachments,
  listProjectArtifacts,
} from './attachments';
import { resolveArtifactAccess } from './artifact-access';
import {
  artifactImpact,
  attachToProject,
  deleteArtifact,
  renameArtifact,
} from './artifact-library';
import { storeDigest } from './artifact-digest';
import { artifactDescribeTool, artifactTools, scoreText, termsOf } from './artifact-tools';
import { createLocalToolSet, type LocalToolContext } from './local-tools';
import { resourceCipher } from './content-crypto';

const listMock = jest.mocked(listAttachments);
const listProjectMock = jest.mocked(listProjectArtifacts);
const textMock = jest.mocked(getAttachmentText);
const accessMock = jest.mocked(resolveArtifactAccess);
const attachMock = jest.mocked(attachToProject);
const findMock = jest.mocked(findChatAttachment);
const storeDigestMock = jest.mocked(storeDigest);

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
    textMock.mockImplementation(async (id) =>
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

describe('artifact_describe', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('stores the digest, as given, for a file of this chat named by its file name', async () => {
    findMock.mockResolvedValue(row('a7', 'plan.pptx') as never);
    const tools = createLocalToolSet([artifactDescribeTool()]);
    const result = await tools.run(
      'artifact_describe',
      {
        filename: 'plan.pptx',
        summary: '  The Q3 rollout plan,  by region. ',
        keywords: ['rollout', 'Q3', 'rollout', ''],
      },
      context()
    );
    expect(result.isError).toBeFalsy();
    expect(findMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      ownerSubject: 'auth0|alice',
      id: null,
      filename: 'plan.pptx',
    });
    expect(storeDigestMock).toHaveBeenCalledWith(null, 'a7', {
      summary: 'The Q3 rollout plan, by region.',
      keywords: ['rollout', 'Q3'],
    });
    expect(result.meta).toEqual({ attachmentId: 'a7' });
  });

  it('needs a summary, a file it can find, and a chat that is not read-only', async () => {
    const tools = createLocalToolSet([artifactDescribeTool()]);
    const empty = await tools.run(
      'artifact_describe',
      { filename: 'plan.pptx', summary: '', keywords: [] },
      context()
    );
    expect(empty.isError).toBe(true);
    expect(findMock).not.toHaveBeenCalled();
    findMock.mockResolvedValue(null);
    const missing = await tools.run(
      'artifact_describe',
      { attachmentId: 'nope', summary: 'A plan.', keywords: [] },
      context()
    );
    expect(missing.isError).toBe(true);
    expect(storeDigestMock).not.toHaveBeenCalled();
    const frozen = await tools.run(
      'artifact_describe',
      { filename: 'plan.pptx', summary: 'A plan.', keywords: [] },
      context({ readOnly: true })
    );
    expect(frozen.isError).toBe(true);
  });
});

describe('artifact_rename and artifact_delete', () => {
  const impactMock = jest.mocked(artifactImpact);
  const deleteMock = jest.mocked(deleteArtifact);
  const renameMock = jest.mocked(renameArtifact);
  const none = { projects: [], sharedWith: [], chat: null };

  beforeEach(() => {
    jest.clearAllMocks();
    findMock.mockResolvedValue(row('a1', 'notes.txt') as never);
  });

  it('renames an owned file through the library, and refuses under read-only mode', async () => {
    renameMock.mockResolvedValue(true);
    const tools = createLocalToolSet(artifactTools({ inProject: true }));
    const done = await tools.run(
      'artifact_rename',
      { attachmentId: 'a1', newName: 'plan.txt' },
      context()
    );
    expect(done.isError).toBeFalsy();
    expect(renameMock).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        ownerSubject: 'auth0|alice',
        artifactId: 'a1',
        filename: 'plan.txt',
      })
    );
    const readOnly = await tools.run(
      'artifact_rename',
      { attachmentId: 'a1', newName: 'x.txt' },
      context({ readOnly: true })
    );
    expect(readOnly.isError).toBe(true);
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it('deletes a file nobody else uses', async () => {
    impactMock.mockResolvedValue(none);
    deleteMock.mockResolvedValue(true);
    const tools = createLocalToolSet(artifactTools({ inProject: false }));
    const done = await tools.run('artifact_delete', { attachmentId: 'a1' }, context());
    expect(done.isError).toBeFalsy();
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to delete a file a project or a colleague still uses, and says who', async () => {
    impactMock.mockResolvedValue({
      projects: [{ id: 'p1', name: 'Rollout', kind: 'chat', members: 3, mode: 'on_demand' }],
      sharedWith: [{ subject: 'auth0|bob', name: 'Bob', email: 'bob@example.com' }],
      chat: null,
    });
    const tools = createLocalToolSet(artifactTools({ inProject: true }));
    const refused = await tools.run('artifact_delete', { attachmentId: 'a1' }, context());
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('project Rollout');
    expect(refused.content[0]?.text).toContain('Bob');
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
