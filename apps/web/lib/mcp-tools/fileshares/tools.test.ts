/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The fileshare tools' contract at the model boundary. Since the fileshare
 * worker owns all I/O on the caller's own credentials, what these tools
 * own is what this suite pins: traversal refusals before any network
 * call, faithful forwarding of the caller's target to the worker client,
 * the mapping of worker refusals onto model-readable messages, the
 * per-share LLM-exposure gates (write and delete opt-ins), the shaped
 * registration, the upload-slot mint, and the delete preview/confirm card.
 */

jest.mock('@/lib/file-shares/service-client', () => ({
  fsListFolder: jest.fn(),
  fsStatEntry: jest.fn(),
  fsReadFile: jest.fn(),
  fsMakeFolder: jest.fn(),
  fsMoveEntry: jest.fn(),
  fsRenameEntry: jest.fn(),
  fsRemoveEntry: jest.fn(),
  fsPreviewRemove: jest.fn(),
}));
jest.mock('../upload-slots', () => ({
  createUploadSlot: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import type { ShareConnection, ShareSummary } from '@renkei/connector-fileshares';
import { registerFileshareTools, type FileshareToolExposure } from './index';
import { NO_SUCH_SHARE } from './fileshare-auth';
import type { FileshareAuth } from './fileshare-auth';
import type { MCPToolContext } from '../common';

const client = jest.requireMock<{
  fsListFolder: jest.Mock;
  fsStatEntry: jest.Mock;
  fsReadFile: jest.Mock;
  fsMakeFolder: jest.Mock;
  fsMoveEntry: jest.Mock;
  fsRenameEntry: jest.Mock;
  fsRemoveEntry: jest.Mock;
  fsPreviewRemove: jest.Mock;
}>('@/lib/file-shares/service-client');
const { createUploadSlot } = jest.requireMock<{ createUploadSlot: jest.Mock }>('../upload-slots');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const SHARE_ID = '11111111-2222-3333-4444-555555555555';
const SHARE = { id: SHARE_ID, name: 'Accounting' };
const TARGET = { tenantId: 'tenant-1', subject: 'auth0|alice', shareId: SHARE_ID };

function contextOf(): MCPToolContext {
  return {
    tenantId: 'tenant-1',
    subject: 'auth0|alice',
    origin: 'https://renkei.example.test',
    maxAttachmentBytes: 1024 * 1024,
  } as unknown as MCPToolContext;
}

function summary(): ShareSummary {
  return {
    id: SHARE_ID,
    name: 'Accounting',
    protocol: 'sftp',
    host: 'nas.example.test',
    port: null,
    shareName: null,
    rootPath: '/srv/accounting',
    caseInsensitive: false,
    enabled: true,
  };
}

function connectionOf(overrides?: Partial<ShareConnection>): ShareConnection {
  return { username: 'alice', toolAccess: 'read_write', allowDelete: true, ...overrides };
}

function authOf(connection: ShareConnection): FileshareAuth {
  return {
    kind: 'user',
    target() {
      return { tenantId: 'tenant-1', subject: 'auth0|alice' };
    },
    async listConnected() {
      return [{ share: summary(), connection }];
    },
    async connection(shareId: string) {
      if (shareId !== SHARE_ID) return NO_SUCH_SHARE;
      return connection;
    },
  };
}

function register(
  connection: ShareConnection = connectionOf(),
  exposure: FileshareToolExposure = { write: true, del: true }
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerFileshareTools(server, contextOf(), authOf(connection), exposure);
  return handlers;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

function opError(type: string, message?: string, status = 400) {
  return { ok: false as const, err: { kind: 'op' as const, type, message, status } };
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Registration shape — the tool list reflects the caller's exposure.
// ---------------------------------------------------------------------------

test('no write exposure anywhere registers the read tools only', () => {
  const handlers = register(connectionOf({ toolAccess: 'read' }), { write: false, del: false });
  expect([...handlers.keys()].sort()).toEqual([
    'fileshare_download_file',
    'fileshare_list_folder',
    'fileshare_list_shares',
    'fileshare_read_file',
    'fileshare_stat',
  ]);
});

test('write exposure without delete registers everything but the delete pair', () => {
  const handlers = register(connectionOf({ allowDelete: false }), { write: true, del: false });
  expect(handlers.has('fileshare_move_entry')).toBe(true);
  expect(handlers.has('fileshare_request_file_upload')).toBe(true);
  expect(handlers.has('fileshare_delete_entry_preview')).toBe(false);
  expect(handlers.has('fileshare_delete_entry_confirm')).toBe(false);
});

test('full exposure registers the delete pair too', () => {
  const handlers = register();
  expect(handlers.has('fileshare_delete_entry_preview')).toBe(true);
  expect(handlers.has('fileshare_delete_entry_confirm')).toBe(true);
});

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

test('list_shares reports name, id, account and the exposure choice', async () => {
  const handlers = register();
  const result = await handlers.get('fileshare_list_shares')!({});
  expect(result.isError).toBeUndefined();
  expect(textOf(result)).toContain('Accounting');
  expect(textOf(result)).toContain(SHARE_ID);
  expect(textOf(result)).toContain('connected as alice');
  expect(textOf(result)).toContain('tools here: read/write + delete');
});

test('list_folder forwards the caller and renders wire entries', async () => {
  client.fsListFolder.mockResolvedValue({
    ok: true,
    val: {
      share: SHARE,
      path: '/',
      entries: [
        {
          name: 'notes.txt',
          path: '/notes.txt',
          kind: 'file',
          size: 5,
          modifiedAt: '2026-01-01T00:00:00.000Z',
        },
        { name: 'drafts', path: '/drafts', kind: 'dir', size: null, modifiedAt: null },
      ],
    },
  });
  const handlers = register();
  const result = await handlers.get('fileshare_list_folder')!({ shareId: SHARE_ID, path: '/' });
  const text = textOf(result);
  expect(result.isError).toBeUndefined();
  expect(client.fsListFolder).toHaveBeenCalledWith(TARGET, '/');
  expect(text).toContain('/notes.txt · 5 bytes');
  expect(text).toContain('/drafts/');
});

test('a traversal path is refused with a reason, never sent to the worker', async () => {
  const handlers = register();
  const result = await handlers.get('fileshare_list_folder')!({
    shareId: SHARE_ID,
    path: '/reports/../../etc',
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('climbs out of the share');
  expect(client.fsListFolder).not.toHaveBeenCalled();
});

test("the worker's not_connected answer becomes the shared refusal", async () => {
  client.fsListFolder.mockResolvedValue(opError('not_connected', undefined, 403));
  const handlers = register();
  const result = await handlers.get('fileshare_list_folder')!({
    shareId: '99999999-9999-9999-9999-999999999999',
    path: '/',
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('No file share with that id is connected for you');
});

test('a file-server refusal names the credentials, not Renkei', async () => {
  client.fsReadFile.mockResolvedValue(opError('access_denied', undefined, 403));
  const handlers = register();
  const result = await handlers.get('fileshare_read_file')!({
    shareId: SHARE_ID,
    path: '/closed/file.txt',
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('file server refused');
  expect(textOf(result)).toContain('your credentials');
});

test('an unconfigured service is a clear refusal, not a crash', async () => {
  client.fsStatEntry.mockResolvedValue({ ok: false, err: { kind: 'unconfigured' } });
  const handlers = register();
  const result = await handlers.get('fileshare_stat')!({ shareId: SHARE_ID, path: '/x' });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('not configured');
});

test('read_file decodes the returned bytes and caps them', async () => {
  client.fsReadFile.mockResolvedValue({
    ok: true,
    val: new TextEncoder().encode('hello world'),
  });
  const handlers = register();
  const result = await handlers.get('fileshare_read_file')!({
    shareId: SHARE_ID,
    path: '/notes.txt',
  });
  expect(result.isError).toBeUndefined();
  expect(textOf(result)).toContain('hello world');
  // The requested cap honors the org attachment limit from the context.
  expect(client.fsReadFile).toHaveBeenCalledWith(TARGET, '/notes.txt', 1024 * 1024);
});

test('download_file hands out the session-guarded REST link, folders refused', async () => {
  client.fsStatEntry.mockResolvedValue({
    ok: true,
    val: { share: SHARE, path: '/report.pdf', kind: 'file', size: 9, modifiedAt: null },
  });
  const handlers = register();
  const result = await handlers.get('fileshare_download_file')!({
    shareId: SHARE_ID,
    path: '/report.pdf',
  });
  expect(result.isError).toBeUndefined();
  expect(textOf(result)).toContain(
    `https://renkei.example.test/api/tenant/tenant-1/fileshares/${SHARE_ID}/file?path=%2Freport.pdf`
  );

  client.fsStatEntry.mockResolvedValue({
    ok: true,
    val: { share: SHARE, path: '/folder', kind: 'dir', size: null, modifiedAt: null },
  });
  const folder = await handlers.get('fileshare_download_file')!({
    shareId: SHARE_ID,
    path: '/folder',
  });
  expect(folder.isError).toBe(true);
  expect(textOf(folder)).toContain('is a folder');
});

// ---------------------------------------------------------------------------
// The per-share exposure gates on act tools.
// ---------------------------------------------------------------------------

test('a registered write tool still refuses a share exposed read-only', async () => {
  // Registered because ANOTHER share exposes write; this one does not.
  const handlers = register(connectionOf({ toolAccess: 'read' }), { write: true, del: true });
  const result = await handlers.get('fileshare_create_folder')!({
    shareId: SHARE_ID,
    path: '/new',
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('Write tools are switched off');
  expect(client.fsMakeFolder).not.toHaveBeenCalled();
});

test('the delete pair refuses a share without the delete opt-in', async () => {
  const handlers = register(connectionOf({ allowDelete: false }), { write: true, del: true });
  for (const tool of ['fileshare_delete_entry_preview', 'fileshare_delete_entry_confirm']) {
    const result = await handlers.get(tool)!({ shareId: SHARE_ID, path: '/old.txt' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Deleting is switched off');
  }
  expect(client.fsRemoveEntry).not.toHaveBeenCalled();
  expect(client.fsPreviewRemove).not.toHaveBeenCalled();
});

test('request_file_upload refuses without write exposure, before any slot', async () => {
  const handlers = register(connectionOf({ toolAccess: 'read' }), { write: true, del: true });
  const result = await handlers.get('fileshare_request_file_upload')!({
    shareId: SHARE_ID,
    path: '/reports',
    filename: 'q4.xlsx',
  });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain('Write tools are switched off');
  expect(createUploadSlot).not.toHaveBeenCalled();
});

test('request_file_upload mints a slot with the share destination', async () => {
  createUploadSlot.mockResolvedValue({ ok: true, uploadId: 'slot-1', instructions: 'POST here' });
  const handlers = register();
  const result = await handlers.get('fileshare_request_file_upload')!({
    shareId: SHARE_ID,
    path: '/reports',
    filename: 'q4.xlsx',
  });
  expect(result.isError).toBeUndefined();
  expect(createUploadSlot).toHaveBeenCalledWith(
    expect.anything(),
    'fileshare-file',
    { shareId: SHARE_ID, path: '/reports' },
    expect.objectContaining({ filename: 'q4.xlsx' })
  );
});

test('request_file_upload refuses filenames carrying separators', async () => {
  const handlers = register();
  const result = await handlers.get('fileshare_request_file_upload')!({
    shareId: SHARE_ID,
    path: '/reports',
    filename: '../../evil.sh',
  });
  expect(result.isError).toBe(true);
  expect(createUploadSlot).not.toHaveBeenCalled();
});

test('create_folder forwards to the worker and phrases exists specially', async () => {
  client.fsMakeFolder.mockResolvedValue({ ok: true, val: { share: SHARE, path: '/drafts/new' } });
  const handlers = register();
  const made = await handlers.get('fileshare_create_folder')!({
    shareId: SHARE_ID,
    path: '/drafts/new',
  });
  expect(made.isError).toBeUndefined();
  expect(textOf(made)).toContain('Created /drafts/new on "Accounting"');
  expect(client.fsMakeFolder).toHaveBeenCalledWith(TARGET, '/drafts/new');

  client.fsMakeFolder.mockResolvedValue(opError('exists', undefined, 409));
  const taken = await handlers.get('fileshare_create_folder')!({
    shareId: SHARE_ID,
    path: '/drafts/new',
  });
  expect(taken.isError).toBe(true);
  expect(textOf(taken)).toContain('already exists');
});

test('move forwards source and destination folder', async () => {
  client.fsMoveEntry.mockResolvedValue({
    ok: true,
    val: { share: SHARE, path: '/archive/a.txt', unchanged: false },
  });
  const handlers = register();
  const moved = await handlers.get('fileshare_move_entry')!({
    shareId: SHARE_ID,
    path: '/a.txt',
    toFolder: '/archive',
  });
  expect(moved.isError).toBeUndefined();
  expect(textOf(moved)).toContain('Moved /a.txt to /archive/a.txt');
  expect(client.fsMoveEntry).toHaveBeenCalledWith(TARGET, '/a.txt', '/archive');
});

test('the share root is refused locally for move, rename and delete', async () => {
  const handlers = register();
  for (const [tool, args] of [
    ['fileshare_move_entry', { shareId: SHARE_ID, path: '/', toFolder: '/x' }],
    ['fileshare_rename_entry', { shareId: SHARE_ID, path: '/', newName: 'x' }],
    ['fileshare_delete_entry_confirm', { shareId: SHARE_ID, path: '/' }],
  ] as const) {
    const result = await handlers.get(tool)!(args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('share root');
  }
  expect(client.fsMoveEntry).not.toHaveBeenCalled();
  expect(client.fsRenameEntry).not.toHaveBeenCalled();
  expect(client.fsRemoveEntry).not.toHaveBeenCalled();
});

test('rename reports clobber refusals and unchanged names', async () => {
  client.fsRenameEntry.mockResolvedValue(
    opError('exists', 'Something already exists at the destination.', 409)
  );
  const handlers = register();
  const clobber = await handlers.get('fileshare_rename_entry')!({
    shareId: SHARE_ID,
    path: '/a.txt',
    newName: 'taken.txt',
  });
  expect(clobber.isError).toBe(true);
  expect(textOf(clobber)).toContain('already exists');

  client.fsRenameEntry.mockResolvedValue({
    ok: true,
    val: { share: SHARE, path: '/a.txt', unchanged: true },
  });
  const unchanged = await handlers.get('fileshare_rename_entry')!({
    shareId: SHARE_ID,
    path: '/a.txt',
    newName: 'a.txt',
  });
  expect(unchanged.isError).toBe(true);
  expect(textOf(unchanged)).toContain('already its name');
});

test('delete preview stages the confirm from the worker preview, no delete call', async () => {
  client.fsPreviewRemove.mockResolvedValue({
    ok: true,
    val: { share: SHARE, path: '/old.txt', kind: 'file', size: 42, modifiedAt: null },
  });
  const handlers = register();
  const result = (await handlers.get('fileshare_delete_entry_preview')!({
    shareId: SHARE_ID,
    path: '/old.txt',
  })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  expect(result.isError).toBeUndefined();
  expect(client.fsRemoveEntry).not.toHaveBeenCalled();
  const card = result.structuredContent ?? {};
  expect(card.confirmTool).toBe('fileshare_delete_entry_confirm');
  expect(card.confirmArgs).toEqual({ shareId: SHARE_ID, path: '/old.txt' });
  expect(card.previewId).toBeTruthy();
  expect(String(card.title)).toContain('permanently');
});

test('delete preview relays the non-empty refusal before any card renders', async () => {
  client.fsPreviewRemove.mockResolvedValue(opError('not_empty', undefined, 409));
  const handlers = register();
  const result = (await handlers.get('fileshare_delete_entry_preview')!({
    shareId: SHARE_ID,
    path: '/stash',
  })) as { isError?: boolean; structuredContent?: unknown; content: { text: string }[] };
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(textOf(result)).toContain('not empty');
});

test('delete confirm executes through the worker', async () => {
  client.fsRemoveEntry.mockResolvedValue({ ok: true, val: { share: SHARE, path: '/old.txt' } });
  const handlers = register();
  const result = await handlers.get('fileshare_delete_entry_confirm')!({
    shareId: SHARE_ID,
    path: '/old.txt',
  });
  expect(result.isError).toBeUndefined();
  expect(textOf(result)).toContain('Deleted /old.txt');
  expect(client.fsRemoveEntry).toHaveBeenCalledWith(TARGET, '/old.txt');
});
