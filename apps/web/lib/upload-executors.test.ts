/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Per-kind upload dispatch. Every executor acts under the requesting user's
 * OWN stored grants, and the drive/draft executors must switch to Graph
 * upload sessions past the simple-upload ceilings (4 MB drive, 3 MB inline
 * message attachment) — base64's implicit cap is gone.
 */

jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/crypto', () => ({
  parseEncryptionKey: jest.fn(() => ({ ok: true, val: 'key' })),
  loadKeyring: jest.fn(() => ({ ok: true, val: 'key' })),
}));
jest.mock('@renkei/provider-grants', () => ({
  ATLASSIAN: 'atlassian',
  ATLASSIAN_JSM: 'atlassian-jsm',
  ONBASE: 'onbase',
  ONBASE_ADMIN: 'onbase-admin',
  readAtlassianMetadata: jest.fn(() => ({ cloudId: 'cloud-1' })),
}));
// The delegate, faked at the client boundary: `describe` stands in for the
// grant row, and the fetcher it hands out is a real AuthedFetch whose
// grantKey names the grant — what the executors pass on, never a token.
const mockDescribe = jest.fn();
jest.mock('@renkei/delegate-client', () => {
  const actual =
    jest.requireActual<typeof import('@renkei/delegate-client')>('@renkei/delegate-client');
  return {
    ...actual,
    delegateGrants: () => ({ describe: (...args: unknown[]) => mockDescribe(...args) }),
    grantFetch: (grant: Parameters<typeof actual.grantKeyOf>[0]) =>
      actual.authedFetch((url, init) => fetch(url, init), actual.grantKeyOf(grant)),
  };
});
jest.mock('@renkei/connector-microsoft', () => ({ graphUploadViaSession: jest.fn() }));
jest.mock('@/lib/mcp-tools/common', () => ({ jiraFetch: jest.fn() }));
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
jest.mock('@/lib/mcp-tools/webex/webex-auth', () => ({
  resolveWebexAccess: jest.fn(),
}));
jest.mock('@/lib/mcp-tools/webex/sent-ledger', () => ({
  recordSentWebexMessage: jest.fn(async () => undefined),
}));
jest.mock('@/lib/webex-bot', () => ({ webexBotClient: jest.fn() }));
jest.mock('@renkei/connector-webex', () => ({ WebexClient: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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
import { authedFetch, type AuthedFetch } from '@renkei/delegate-client';
import {
  executeUpload,
  finalizeUploadSlot,
  completeUploadSlot,
  type UploadSlotRow,
} from './upload-executors';

const { graphUploadViaSession } = jest.requireMock<{ graphUploadViaSession: jest.Mock }>(
  '@renkei/connector-microsoft'
);
const { jiraFetch } = jest.requireMock<{ jiraFetch: jest.Mock }>('@/lib/mcp-tools/common');
const { graphPost, graphPutContent, resolveGraphAccess } = jest.requireMock<{
  graphPost: jest.Mock;
  graphPutContent: jest.Mock;
  resolveGraphAccess: jest.Mock;
}>('@/lib/mcp-tools/graph/client');
const { confluenceUpload, resolveConfluenceAccess } = jest.requireMock<{
  confluenceUpload: jest.Mock;
  resolveConfluenceAccess: jest.Mock;
}>('@/lib/mcp-tools/confluence/client');
const { resolveWebexAccess } = jest.requireMock<{ resolveWebexAccess: jest.Mock }>(
  '@/lib/mcp-tools/webex/webex-auth'
);
const { recordSentWebexMessage } = jest.requireMock<{ recordSentWebexMessage: jest.Mock }>(
  '@/lib/mcp-tools/webex/sent-ledger'
);
const { webexBotClient } = jest.requireMock<{ webexBotClient: jest.Mock }>('@/lib/webex-bot');
const { WebexClient: MockWebexClient } = jest.requireMock<{ WebexClient: jest.Mock }>(
  '@renkei/connector-webex'
);

function slotOf(kind: string, destination: unknown): UploadSlotRow {
  return {
    id: 'slot-1',
    subject: 'subject-1',
    account_id: 'acct-1',
    kind,
    destination,
    filename: 'report.pdf',
    content_type: 'application/pdf',
  };
}

/** A fetcher as the delegate would hand it out for a resolved grant, recording its calls. */
function fakeAuth(
  grantKey: string,
  send: (url: string, init?: RequestInit) => Promise<Response> = async () =>
    new Response('{}', { status: 200 })
): AuthedFetch & { calls: jest.Mock } {
  const calls = jest.fn(send);
  return Object.assign(authedFetch(calls, grantKey), { calls });
}

/** No executor under test reads the db, except OnBase's slot update (not exercised here). */
const db = {} as unknown as Kysely<DB>;

const graphAuth = fakeAuth('microsoft:tenant-1:ms-1');

beforeEach(() => {
  mockDescribe.mockReset();
  graphUploadViaSession.mockReset();
  jiraFetch.mockReset();
  graphPost.mockReset();
  graphPutContent.mockReset();
  resolveGraphAccess.mockReset();
  confluenceUpload.mockReset();
  resolveConfluenceAccess.mockReset();
  resolveWebexAccess.mockReset();
  recordSentWebexMessage.mockReset();
  webexBotClient.mockReset();
  webexBotClient.mockResolvedValue(null);
  MockWebexClient.mockReset();
  // Every Atlassian grant exists unless a test says otherwise; the account
  // id echoes the one asked for (or the JSM grant's own, by subject).
  mockDescribe.mockImplementation(async (grant: { provider: string; accountId?: string }) => ({
    ok: true,
    val: {
      accountId: grant.accountId ?? (grant.provider === 'atlassian-jsm' ? 'jsm-acct' : 'acct-1'),
      metadata: {},
    },
  }));
  resolveGraphAccess.mockResolvedValue({ auth: graphAuth, upn: null, accountId: 'ms-1' });
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
    const [url, auth, init] = jiraFetch.mock.calls[0] as [
      string,
      AuthedFetch,
      { method: string; body: unknown },
    ];
    expect(url).toBe(
      'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/PROJ-1/attachments'
    );
    // The slot's own Jira grant, as a fetcher — never a token.
    expect(typeof auth).toBe('function');
    expect(auth.grantKey).toBe('atlassian:tenant-1:acct-1');
    expect(init.body).toBeInstanceOf(FormData);
    expect(mockDescribe).toHaveBeenCalledWith({
      provider: 'atlassian',
      accountId: 'acct-1',
    });
  });

  it('fails cleanly when no usable Atlassian grant exists', async () => {
    mockDescribe.mockResolvedValue({ ok: false, err: { type: 'NO_GRANT' } });

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
    // The JSM grant is preferred, looked up by the slot's subject.
    expect(mockDescribe.mock.calls[0]![0]).toEqual({
      provider: 'atlassian-jsm',
      subject: 'subject-1',
    });
    expect((jiraFetch.mock.calls[0]![1] as AuthedFetch).grantKey).toBe(
      'atlassian-jsm:tenant-1:jsm-acct'
    );
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
    const confluenceAuth = fakeAuth('atlassian-confluence:tenant-1:acct-1');
    resolveConfluenceAccess.mockResolvedValue({
      auth: confluenceAuth,
      cloudId: 'cloud-1',
      accountId: 'acct-1',
    });
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
    // The resolved access rides through whole: the fetcher is the client's to use.
    expect((confluenceUpload.mock.calls[0]![1] as { auth: AuthedFetch }).auth).toBe(confluenceAuth);
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
    // The Graph helpers take the grant's fetcher where the token used to go.
    expect(graphPutContent.mock.calls[0]![1]).toBe(graphAuth);
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
    expect(graphUploadViaSession.mock.calls[0]![0]).toBe(graphAuth);
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

describe('webex-attachment', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    // The multipart POST goes through the grant's fetcher, never raw fetch.
    global.fetch = jest.fn(async () => {
      throw new Error('unexpected raw fetch');
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('multiparts the bytes to a room on the resolved grant’s fetcher, and records the send', async () => {
    const webexAuth = fakeAuth(
      'webex:tenant-1:subject-1',
      async () => new Response('{"id":"msg-room"}', { status: 200 })
    );
    resolveWebexAccess.mockResolvedValue({ auth: webexAuth, personEmail: 'a@x.com' });

    const outcome = await executeUpload(
      db,
      slotOf('webex-attachment', { roomId: 'room-1', markdown: 'see attached' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('report.pdf');
    // Posted as the user: without the ledger row their own webhook would
    // re-ingest it as something they typed.
    expect(recordSentWebexMessage).toHaveBeenCalledWith('tenant-1', 'msg-room', 'acct-1');
    expect(webexBotClient).not.toHaveBeenCalled();
    const [url, init] = webexAuth.calls.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://webexapis.com/v1/messages');
    // No Authorization of our own: the delegate attaches the credential.
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('roomId')).toBe('room-1');
    expect(form.get('markdown')).toBe('see attached');
    const file = form.get('files') as File;
    expect(file.name).toBe('report.pdf');
  });

  it('multiparts to a 1:1 recipient with parentId, when the slot carries one', async () => {
    const webexAuth = fakeAuth('webex:tenant-1:subject-1');
    resolveWebexAccess.mockResolvedValue({ auth: webexAuth, personEmail: null });

    await executeUpload(
      db,
      slotOf('webex-attachment', { toPersonEmail: 'bob@example.com', parentId: 'msg-root' }),
      Buffer.from('bytes')
    );

    const [, init] = webexAuth.calls.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get('toPersonEmail')).toBe('bob@example.com');
    expect(form.get('parentId')).toBe('msg-root');
    expect(form.get('roomId')).toBeNull();
  });

  it('fails cleanly when the slot carries no room or recipient', async () => {
    const outcome = await executeUpload(db, slotOf('webex-attachment', {}), Buffer.from('bytes'));

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('no room or recipient');
    expect(resolveWebexAccess).not.toHaveBeenCalled();
  });

  it('fails cleanly when there is no usable WebEx grant', async () => {
    resolveWebexAccess.mockResolvedValue('WebEx is not connected.');

    const outcome = await executeUpload(
      db,
      slotOf('webex-attachment', { roomId: 'room-1' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('WebEx is not connected.');
  });

  it('fails cleanly when WebEx refuses the send', async () => {
    resolveWebexAccess.mockResolvedValue({
      auth: fakeAuth(
        'webex:tenant-1:subject-1',
        async () => new Response('{"message":"bad request"}', { status: 400 })
      ),
      personEmail: null,
    });

    const outcome = await executeUpload(
      db,
      slotOf('webex-attachment', { roomId: 'room-1' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('400');
    expect(outcome.detail).toContain('bad request');
  });

  it('phrases a delegate refusal in the resolver’s words, not as a WebEx status', async () => {
    // The grant died between the describe and the send: the delegate
    // answers for itself, marked by x-delegate-error.
    resolveWebexAccess.mockResolvedValue({
      auth: fakeAuth(
        'webex:tenant-1:subject-1',
        async () =>
          new Response('{"error":{"type":"GRANT_REVOKED"}}', {
            status: 403,
            headers: { 'x-delegate-error': 'GRANT_REVOKED' },
          })
      ),
      personEmail: null,
    });

    const outcome = await executeUpload(
      db,
      slotOf('webex-attachment', { roomId: 'room-1' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe(
      'Your WebEx authorization was revoked. Reconnect it on the Connectors page.'
    );
    expect(recordSentWebexMessage).not.toHaveBeenCalled();
  });
});

describe('webex-attachment to self', () => {
  const realFetch = global.fetch;
  const webexAuth = fakeAuth('webex:tenant-1:subject-1');
  const selfSlot = (markdown?: string) =>
    slotOf('webex-attachment', { noteToSelf: true, ...(markdown ? { markdown } : {}) });
  const expectedFile = expect.objectContaining({
    filename: 'report.pdf',
    contentType: 'application/pdf',
    bytes: expect.any(Uint8Array),
  });

  beforeEach(() => {
    // Anything that reaches raw fetch here is a bug: the self path speaks
    // through the bot client or WebexClient, never the multipart POST above.
    global.fetch = jest.fn(async () => {
      throw new Error('unexpected raw fetch');
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends as the org bot first, so the note arrives unread', async () => {
    resolveWebexAccess.mockResolvedValue({ auth: webexAuth, personEmail: 'a@x.com' });
    const postMessage = jest
      .fn()
      .mockResolvedValue({ ok: true, val: { id: 'msg-bot', roomId: 'dm-1' } });
    webexBotClient.mockResolvedValue({ postMessage });

    const outcome = await executeUpload(db, selfSlot('for later'), Buffer.from('bytes'));

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('bot');
    expect(webexBotClient).toHaveBeenCalledWith('tenant-1');
    expect(postMessage).toHaveBeenCalledWith({
      toPersonEmail: 'a@x.com',
      markdown: 'for later',
      file: expectedFile,
    });
    expect(MockWebexClient).not.toHaveBeenCalled();
    expect(recordSentWebexMessage).toHaveBeenCalledWith('tenant-1', 'msg-bot', 'acct-1');
  });

  it('falls back to the user’s own Note to Self space when the org has no bot', async () => {
    resolveWebexAccess.mockResolvedValue({ auth: webexAuth, personEmail: 'a@x.com' });
    const sendNoteToSelf = jest
      .fn()
      .mockResolvedValue({ ok: true, val: { id: 'msg-self', roomId: 'room-solo' } });
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    const outcome = await executeUpload(db, selfSlot('for later'), Buffer.from('bytes'));

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('Note to Self');
    expect(MockWebexClient).toHaveBeenCalledWith(webexAuth, { lane: 'interactive' });
    expect(sendNoteToSelf).toHaveBeenCalledWith('for later', expectedFile);
    expect(recordSentWebexMessage).toHaveBeenCalledWith('tenant-1', 'msg-self', 'acct-1');
  });

  it('falls back to the solo space when the bot cannot deliver', async () => {
    resolveWebexAccess.mockResolvedValue({ auth: webexAuth, personEmail: 'a@x.com' });
    const postMessage = jest
      .fn()
      .mockResolvedValue({ ok: false, err: { type: 'WEBEX_API_ERROR', message: '403' } });
    webexBotClient.mockResolvedValue({ postMessage });
    const sendNoteToSelf = jest
      .fn()
      .mockResolvedValue({ ok: true, val: { id: 'msg-self', roomId: 'room-solo' } });
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    const outcome = await executeUpload(db, selfSlot(), Buffer.from('bytes'));

    expect(outcome.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    // No markdown on the slot: the file goes alone, with an empty body.
    expect(sendNoteToSelf).toHaveBeenCalledWith('', expectedFile);
  });

  it('skips the bot when the grant recorded no address for it to reach', async () => {
    resolveWebexAccess.mockResolvedValue({ auth: webexAuth, personEmail: null });
    const postMessage = jest.fn();
    webexBotClient.mockResolvedValue({ postMessage });
    const sendNoteToSelf = jest
      .fn()
      .mockResolvedValue({ ok: true, val: { id: 'msg-self', roomId: 'room-solo' } });
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    const outcome = await executeUpload(db, selfSlot(), Buffer.from('bytes'));

    expect(outcome.ok).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
    expect(sendNoteToSelf).toHaveBeenCalledTimes(1);
  });

  it('surfaces the solo-space failure when both routes fail', async () => {
    resolveWebexAccess.mockResolvedValue({ auth: webexAuth, personEmail: 'a@x.com' });
    const sendNoteToSelf = jest.fn().mockResolvedValue({
      ok: false,
      err: { type: 'WEBEX_API_ERROR', message: 'WebEx API 403 for /rooms' },
    });
    MockWebexClient.mockImplementation(() => ({ sendNoteToSelf }));

    const outcome = await executeUpload(db, selfSlot(), Buffer.from('bytes'));

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('403');
    expect(recordSentWebexMessage).not.toHaveBeenCalled();
  });

  it('fails before consulting the bot when there is no usable grant', async () => {
    resolveWebexAccess.mockResolvedValue('WebEx is not connected.');

    const outcome = await executeUpload(db, selfSlot(), Buffer.from('bytes'));

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('WebEx is not connected.');
    expect(webexBotClient).not.toHaveBeenCalled();
  });
});

describe('fileshare-file', () => {
  const { fsWriteFile } = jest.requireMock<{ fsWriteFile: jest.Mock }>(
    '@/lib/file-shares/service-client'
  );

  it('relays the file server refusal at byte-arrival time', async () => {
    // The slot was minted earlier; by POST time the server says no — the
    // worker runs the write on the caller's own credential and relays it.
    fsWriteFile.mockResolvedValue({
      ok: false,
      err: { kind: 'op' as const, type: 'access_denied', message: undefined, status: 403 },
    });

    const outcome = await executeUpload(
      db,
      slotOf('fileshare-file', { shareId: 'share-1', path: '/reports' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('refused the write');
  });

  it('refuses when the caller disconnected the share after minting', async () => {
    fsWriteFile.mockResolvedValue({
      ok: false,
      err: { kind: 'op' as const, type: 'not_connected', message: undefined, status: 403 },
    });

    const outcome = await executeUpload(
      db,
      slotOf('fileshare-file', { shareId: 'share-1', path: '/reports' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('no longer connected');
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

/** A minimal updateTable() stand-in that records what finalizeUploadSlot sets. */
function dbRecordingUpdates(): { db: Kysely<DB>; updates: Array<Record<string, unknown>> } {
  const updates: Array<Record<string, unknown>> = [];
  const chain = {
    set(values: Record<string, unknown>) {
      updates.push(values);
      return chain;
    },
    where: () => chain,
    execute: async () => undefined,
  };
  return { db: { updateTable: () => chain } as unknown as Kysely<DB>, updates };
}

describe('finalizeUploadSlot', () => {
  it('marks a successful outcome completed with its detail as the result', async () => {
    const { db: recordingDb, updates } = dbRecordingUpdates();

    const outcome = await finalizeUploadSlot(
      recordingDb,
      { id: 'slot-1' },
      { ok: true, detail: 'done' }
    );

    expect(outcome).toEqual({ ok: true, detail: 'done' });
    expect(updates).toEqual([
      { status: 'completed', result: 'done', completed_at: 'sql-fragment' },
    ]);
  });

  it('marks a failed outcome failed with its detail as the result', async () => {
    const { db: recordingDb, updates } = dbRecordingUpdates();

    const outcome = await finalizeUploadSlot(
      recordingDb,
      { id: 'slot-1' },
      { ok: false, detail: 'no good' }
    );

    expect(outcome).toEqual({ ok: false, detail: 'no good' });
    expect(updates).toEqual([
      { status: 'failed', result: 'no good', completed_at: 'sql-fragment' },
    ]);
  });
});

describe('completeUploadSlot', () => {
  it('runs executeUpload then finalizes the slot with its outcome', async () => {
    const { db: recordingDb, updates } = dbRecordingUpdates();
    jiraFetch.mockResolvedValue({ text: async () => '[]' });

    const outcome = await completeUploadSlot(
      recordingDb,
      slotOf('jira-attachment', { issueKey: 'PROJ-1' }),
      Buffer.from('bytes')
    );

    expect(outcome.ok).toBe(true);
    expect(updates).toEqual([
      { status: 'completed', result: outcome.detail, completed_at: 'sql-fragment' },
    ]);
  });
});
