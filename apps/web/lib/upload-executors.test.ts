/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Per-kind upload dispatch. Every executor acts under the requesting user's
 * OWN stored grants, and the drive/draft executors must switch to Graph
 * upload sessions past the simple-upload ceilings (4 MB drive, 3 MB inline
 * message attachment) — base64's implicit cap is gone.
 */

jest.mock('@renkei/crypto', () => ({
  parseEncryptionKey: jest.fn(() => ({ ok: true, val: 'key' })),
}));
jest.mock('@renkei/provider-grants', () => ({
  ATLASSIAN: 'atlassian',
  ATLASSIAN_JSM: 'atlassian-jsm',
  getGrant: jest.fn(),
  readAtlassianMetadata: jest.fn(() => ({ cloudId: 'cloud-1' })),
}));
jest.mock('@renkei/connector-microsoft', () => ({ graphUploadViaSession: jest.fn() }));
jest.mock('@/lib/mcp-tools/common', () => ({
  cacheTokenMetadata: jest.fn(),
  jiraFetch: jest.fn(),
}));
jest.mock('@/lib/mcp-tools/graph/client', () => ({
  graphPost: jest.fn(),
  graphPutContent: jest.fn(),
  resolveGraphAccess: jest.fn(),
  str: (value: unknown) => (typeof value === 'string' ? value : ''),
  rec: (value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {},
}));
jest.mock('@/lib/mcp-tools/confluence/client', () => ({
  confluenceUpload: jest.fn(),
  resolveConfluenceAccess: jest.fn(),
}));
jest.mock('@/lib/file-shares/service-client', () => {
  const actual = jest.requireActual<typeof import('@/lib/file-shares/service-client')>(
    '@/lib/file-shares/service-client'
  );
  return {
    ...actual,
    fsWriteFile: jest.fn(),
  };
});

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { executeUpload, type UploadSlotRow } from './upload-executors';

const { getGrant } = jest.requireMock<{ getGrant: jest.Mock }>('@renkei/provider-grants');
const { graphUploadViaSession } = jest.requireMock<{ graphUploadViaSession: jest.Mock }>(
  '@renkei/connector-microsoft'
);
const { cacheTokenMetadata, jiraFetch } = jest.requireMock<{
  cacheTokenMetadata: jest.Mock;
  jiraFetch: jest.Mock;
}>('@/lib/mcp-tools/common');
const { graphPost, graphPutContent, resolveGraphAccess } = jest.requireMock<{
  graphPost: jest.Mock;
  graphPutContent: jest.Mock;
  resolveGraphAccess: jest.Mock;
}>('@/lib/mcp-tools/graph/client');
const { confluenceUpload, resolveConfluenceAccess } = jest.requireMock<{
  confluenceUpload: jest.Mock;
  resolveConfluenceAccess: jest.Mock;
}>('@/lib/mcp-tools/confluence/client');

function slotOf(kind: string, destination: unknown): UploadSlotRow {
  return {
    id: 'slot-1',
    tenant_id: 'tenant-1',
    subject: 'subject-1',
    account_id: 'acct-1',
    kind,
    destination,
    filename: 'report.pdf',
    content_type: 'application/pdf',
  };
}

/** resolveAtlassian only touches the db when it prefers a JSM grant. */
function dbWithJsmGrant(row: { provider_account_id: string } | undefined): Kysely<DB> {
  const chain = {
    select: () => chain,
    where: () => chain,
    limit: () => chain,
    executeTakeFirst: async () => row,
  };
  return { selectFrom: () => chain } as unknown as Kysely<DB>;
}

const db = dbWithJsmGrant(undefined);

beforeEach(() => {
  getGrant.mockReset();
  graphUploadViaSession.mockReset();
  cacheTokenMetadata.mockReset();
  jiraFetch.mockReset();
  graphPost.mockReset();
  graphPutContent.mockReset();
  resolveGraphAccess.mockReset();
  confluenceUpload.mockReset();
  resolveConfluenceAccess.mockReset();
  getGrant.mockResolvedValue({
    ok: true,
    val: { accessToken: 'atl-token', accountId: 'acct-1', metadata: {} },
  });
  resolveGraphAccess.mockResolvedValue({ accessToken: 'graph-token' });
});

describe('jira-attachment', () => {
  it('multiparts the bytes to the issue under the stored grant', async () => {
    jiraFetch.mockResolvedValue({ text: async () => '[]' });

    const outcome = await executeUpload(
      db,
      slotOf('jira-attachment', { issueKey: 'PROJ-1' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('PROJ-1');
    const [url, token, init] = jiraFetch.mock.calls[0] as [
      string,
      string,
      { method: string; body: unknown },
    ];
    expect(url).toBe(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/PROJ-1/attachments'
    );
    expect(token).toBe('atl-token');
    expect(init.body).toBeInstanceOf(FormData);
    // Arms jiraFetch's 401-refresh path, as the MCP transport does.
    expect(cacheTokenMetadata).toHaveBeenCalled();
  });

  it('fails cleanly when no usable Atlassian grant exists', async () => {
    getGrant.mockResolvedValue({ ok: false, err: 'nope' });

    const outcome = await executeUpload(
      db,
      slotOf('jira-attachment', { issueKey: 'PROJ-1' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('No usable Atlassian grant');
    expect(jiraFetch).not.toHaveBeenCalled();
  });
});

describe('jsm-attachment', () => {
  it('runs the two-legged servicedesk flow', async () => {
    jiraFetch
      .mockResolvedValueOnce({ json: async () => ({ serviceDeskId: '7' }) })
      .mockResolvedValueOnce({
        json: async () => ({ temporaryAttachments: [{ temporaryAttachmentId: 'tmp-1' }] }),
      })
      .mockResolvedValueOnce({ text: async () => '' });

    const outcome = await executeUpload(
      db,
      slotOf('jsm-attachment', { requestKey: 'HELP-9' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(true);
    expect(jiraFetch).toHaveBeenCalledTimes(3);
    expect(String(jiraFetch.mock.calls[1]![0])).toContain(
      '/rest/servicedeskapi/servicedesk/7/attachTemporaryFile'
    );
    const attachInit = jiraFetch.mock.calls[2]![2] as { body: string };
    expect(JSON.parse(attachInit.body)).toEqual({
      temporaryAttachmentIds: ['tmp-1'],
      public: true,
    });
  });
});

describe('confluence-attachment', () => {
  it('uploads through confluenceUpload under the resolved access', async () => {
    resolveConfluenceAccess.mockResolvedValue({ accessToken: 'conf-token' });
    confluenceUpload.mockResolvedValue({ ok: true, body: {} });

    const outcome = await executeUpload(
      db,
      slotOf('confluence-attachment', { contentId: '12345' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(true);
    expect(String(confluenceUpload.mock.calls[0]![2])).toBe(
      '/rest/api/content/12345/child/attachment'
    );
  });
});

describe('onedrive/sharepoint documents', () => {
  const destination = { driveId: 'd1', parentItemId: 'p1', ifNameTaken: 'rename' };

  it('simple-PUTs a small file', async () => {
    graphPutContent.mockResolvedValue({ ok: true, body: { id: 'item-1', name: 'report.pdf' } });

    const outcome = await executeUpload(
      db,
      slotOf('onedrive-document', destination),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('item-1');
    expect(graphUploadViaSession).not.toHaveBeenCalled();
    expect(String(graphPutContent.mock.calls[0]![2])).toContain(
      '/drives/d1/items/p1:/report.pdf:/content'
    );
  });

  it('switches to an upload session past the 4 MB simple-PUT ceiling', async () => {
    graphUploadViaSession.mockResolvedValue({ ok: true, val: { id: 'item-1', name: 'big.bin' } });

    const outcome = await executeUpload(
      db,
      slotOf('sharepoint-document', destination),
      Buffer.alloc(4 * 1024 * 1024 + 1)
    );

    expect(outcome.ok).toBe(true);
    expect(graphPutContent).not.toHaveBeenCalled();
    expect(String(graphUploadViaSession.mock.calls[0]![1])).toContain(':/createUploadSession');
  });
});

describe('outlook-draft-attachment', () => {
  it('posts a small file inline as a fileAttachment', async () => {
    graphPost.mockResolvedValue({ ok: true, body: {} });

    const outcome = await executeUpload(
      db,
      slotOf('outlook-draft-attachment', { draftId: 'draft-1' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(true);
    expect(graphUploadViaSession).not.toHaveBeenCalled();
    const payload = graphPost.mock.calls[0]![3] as { contentBytes: string };
    expect(Buffer.from(payload.contentBytes, 'base64').toString()).toBe('bytes');
  });

  it('switches to an attachment upload session past 3 MB', async () => {
    graphUploadViaSession.mockResolvedValue({ ok: true, val: {} });

    const outcome = await executeUpload(
      db,
      slotOf('outlook-draft-attachment', { draftId: 'draft-1' }),
      Buffer.alloc(3 * 1024 * 1024 + 1)
    );

    expect(outcome.ok).toBe(true);
    expect(graphPost).not.toHaveBeenCalled();
    expect(String(graphUploadViaSession.mock.calls[0]![1])).toContain(
      '/me/messages/draft-1/attachments/createUploadSession'
    );
  });
});

it('refuses an unknown kind', async () => {
  const outcome = await executeUpload(db, slotOf('mystery', {}), Buffer.from('bytes'));
  expect(outcome.ok).toBe(false);
  expect(outcome.detail).toContain('mystery');
});

describe('fileshare-file', () => {
  const { fsWriteFile } = jest.requireMock<{ fsWriteFile: jest.Mock }>(
    '@/lib/file-shares/service-client'
  );

  it('relays the worker refusal when the grant was narrowed after minting', async () => {
    // The slot was minted when the caller held read_write; by POST time the
    // grant says read. The worker re-runs the ACL at byte arrival and says no.
    fsWriteFile.mockResolvedValue({
      ok: false,
      err: { kind: 'op' as const, type: 'forbidden', message: undefined, status: 403 },
    });

    const outcome = await executeUpload(
      db,
      slotOf('fileshare-file', { shareId: 'share-1', path: '/reports' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('no longer have read/write');
  });

  it('refuses when the share is no longer visible to the subject', async () => {
    fsWriteFile.mockResolvedValue({
      ok: false,
      err: { kind: 'op' as const, type: 'no_share', message: undefined, status: 404 },
    });

    const outcome = await executeUpload(
      db,
      slotOf('fileshare-file', { shareId: 'share-1', path: '/reports' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('no longer available');
  });

  it('writes to the slot destination as the slot subject', async () => {
    fsWriteFile.mockResolvedValue({ ok: true, val: { path: '/reports/report.pdf' } });

    const outcome = await executeUpload(
      db,
      slotOf('fileshare-file', { shareId: 'share-1', path: '/reports' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(true);
    expect(fsWriteFile).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', shareId: 'share-1', subject: 'subject-1' },
      '/reports/report.pdf',
      expect.any(Uint8Array)
    );
  });
});
