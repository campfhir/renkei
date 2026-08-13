 
/**
 * Drive polling. Almost every case here is a way drive delta differs from
 * mail delta — the differences are silent when got wrong: deletions that
 * never delete, libraries that re-embed themselves every fifteen minutes,
 * a cursor that restarts an enumeration instead of resuming it.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/knowledge', () => ({ readObjectMetadataBatch: jest.fn() }));
jest.mock('../enqueue', () => ({ enqueueKnowledgeEvent: jest.fn() }));
jest.mock('@renkei/connector-microsoft', () => ({
  initialDeltaUrl: jest.fn(() => '/drives/d1/root/delta?$select=cTag'),
  runDeltaRound: jest.fn(),
  sharepointRefId: (driveId: string, itemId: string) => `${driveId}/${itemId}`,
  SHAREPOINT_KNOWLEDGE_PROVIDER: 'sharepoint',
}));

import { runDriveWatchSync, type DriveWatchRow } from './sharepoint-watch';
import type { MicrosoftAccess } from './microsoft-access';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { runDeltaRound: mockRunDeltaRound } = jest.requireMock<{ runDeltaRound: jest.Mock }>(
  '@renkei/connector-microsoft'
);
const { readObjectMetadataBatch: mockReadMetadata } = jest.requireMock<{
  readObjectMetadataBatch: jest.Mock;
}>('@renkei/knowledge');
const { enqueueKnowledgeEvent: mockEnqueue } = jest.requireMock<{
  enqueueKnowledgeEvent: jest.Mock;
}>('../enqueue');

/** What the sync wrote back to content_watches. */
let written: Record<string, unknown> | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  written = null;
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      updateTable: () => ({
        set: (values: Record<string, unknown>) => {
          written = values;
          return { where: () => ({ execute: async () => [] }) };
        },
      }),
    },
  });
  mockReadMetadata.mockResolvedValue({ ok: true, val: new Map() });
});

const access = (): MicrosoftAccess => ({
  accessToken: 'token',
  accountId: 'acct-1',
  upn: 'alice@example.com',
  scopes: ['Files.Read.All'],
});

const row = (over: Partial<DriveWatchRow> = {}): DriveWatchRow => ({
  id: 'watch-1',
  tenant_id: 'tenant-1',
  account_id: 'acct-1',
  scope_key: 'drive-1',
  scope_label: 'Engineering / Shared Documents',
  cursor: 'https://graph/delta?token=abc',
  ...over,
});

function fileEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    name: 'spec.docx',
    size: 4096,
    cTag: 'ctag-1',
    lastModifiedDateTime: '2026-08-12T10:00:00Z',
    webUrl: 'https://contoso.sharepoint.com/spec.docx',
    file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    parentReference: { path: '/drive/root:/Specs' },
    ...over,
  };
}

const delta = (items: unknown[], over: Record<string, unknown> = {}) => ({
  ok: true,
  val: { items, deltaLink: 'https://graph/delta?token=next', nextLink: null, ...over },
});

const eventsOfType = (type: string) => mockEnqueue.mock.calls.filter((call) => call[1] === type);

describe('runDriveWatchSync', () => {
  it('enqueues a reference per changed document — never the bytes', async () => {
    mockRunDeltaRound.mockResolvedValue(delta([fileEntry()]));

    const result = await runDriveWatchSync('tenant-1', access(), row());

    expect(result.items).toBe(1);
    const [tenantId, type, payload, orderingKey] = eventsOfType('ingest.document')[0]!;
    expect(tenantId).toBe('tenant-1');
    expect(type).toBe('ingest.document');
    expect(payload).toMatchObject({
      provider: 'sharepoint',
      refId: 'drive-1/item-1',
      driveId: 'drive-1',
      itemId: 'item-1',
      accountId: 'acct-1',
      cTag: 'ctag-1',
    });
    // Identifiers only: a payload carrying file content would be TOASTed and
    // kept in the dead-letter table forever.
    expect(JSON.stringify(payload)).not.toContain('bytes');
    // Per drive, so the reconcile can rely on lane FIFO.
    expect(orderingKey).toBe('sharepoint/drive-1');
  });

  it('treats a `deleted` facet as a deletion — mail’s @removed never appears', async () => {
    mockRunDeltaRound.mockResolvedValue(delta([{ id: 'item-9', deleted: { state: 'deleted' } }]));

    const result = await runDriveWatchSync('tenant-1', access(), row());

    expect(result.removed).toBe(1);
    expect(eventsOfType('delete.object')[0]![2]).toEqual({
      provider: 'sharepoint',
      refId: 'drive-1/item-9',
    });
  });

  it('skips a document whose cTag is unchanged', async () => {
    // The single biggest cost saver: without it every resync re-downloads and
    // re-embeds a whole library.
    mockReadMetadata.mockResolvedValue({
      ok: true,
      val: new Map([['drive-1/item-1', { cTag: 'ctag-1' }]]),
    });
    mockRunDeltaRound.mockResolvedValue(delta([fileEntry({ cTag: 'ctag-1' })]));

    const result = await runDriveWatchSync('tenant-1', access(), row());

    expect(result.skipped).toBe(1);
    expect(result.items).toBe(0);
    expect(eventsOfType('ingest.document')).toHaveLength(0);
  });

  it('re-ingests when the cTag moved, even if other fields did not', async () => {
    mockReadMetadata.mockResolvedValue({
      ok: true,
      val: new Map([['drive-1/item-1', { cTag: 'ctag-OLD' }]]),
    });
    mockRunDeltaRound.mockResolvedValue(delta([fileEntry({ cTag: 'ctag-NEW' })]));

    const result = await runDriveWatchSync('tenant-1', access(), row());
    expect(result.items).toBe(1);
  });

  it('skips folders, the drive root and packages', async () => {
    mockRunDeltaRound.mockResolvedValue(
      delta([
        { id: 'root-1', root: {}, folder: { childCount: 3 } },
        { id: 'folder-1', name: 'Specs', folder: { childCount: 2 } },
        { id: 'note-1', name: 'Notebook', package: { type: 'oneNote' } },
      ])
    );

    const result = await runDriveWatchSync('tenant-1', access(), row());

    expect(result.items).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('never fetches a file it cannot read: unsupported types are dropped by name', async () => {
    mockRunDeltaRound.mockResolvedValue(
      delta([fileEntry({ id: 'v1', name: 'demo.mp4', file: { mimeType: 'video/mp4' } })])
    );

    const result = await runDriveWatchSync('tenant-1', access(), row());

    expect(result.unsupported).toBe(1);
    expect(eventsOfType('ingest.document')).toHaveLength(0);
  });

  it('drops oversized files before any download is scheduled', async () => {
    mockRunDeltaRound.mockResolvedValue(
      delta([fileEntry({ id: 'big', name: 'huge.pdf', size: 500 * 1024 * 1024 })])
    );

    const result = await runDriveWatchSync('tenant-1', access(), row());
    expect(result.oversized).toBe(1);
    expect(eventsOfType('ingest.document')).toHaveLength(0);
  });

  it('persists a capped round’s nextLink so the next round resumes', async () => {
    mockRunDeltaRound.mockResolvedValue(
      delta([], { deltaLink: null, nextLink: 'https://graph/page-11' })
    );

    const result = await runDriveWatchSync('tenant-1', access(), row());

    expect(result.cursor).toBe('https://graph/page-11');
    expect(written).toMatchObject({ cursor: 'https://graph/page-11', sync_status: 'syncing' });
  });

  it('drops the cursor on a 410 rather than treating it as an error', async () => {
    // An expired delta token is an instruction to re-enumerate, and the cTag
    // skip makes that cost enumeration only.
    mockRunDeltaRound.mockResolvedValue({
      ok: false,
      err: { type: 'GRAPH_API_ERROR', cause: 410, message: 'resyncRequired' },
    });

    const result = await runDriveWatchSync('tenant-1', access(), row());

    expect(result.cursor).toBeNull();
    expect(written).toMatchObject({ cursor: null });
  });

  it('throws on a genuine delta failure so the sweep records it on the row', async () => {
    mockRunDeltaRound.mockResolvedValue({
      ok: false,
      err: { type: 'GRAPH_API_ERROR', cause: 503, message: 'service unavailable' },
    });

    await expect(runDriveWatchSync('tenant-1', access(), row())).rejects.toThrow(/delta round/);
  });

  it('reconciles only when a cursorless enumeration actually closes', async () => {
    mockRunDeltaRound.mockResolvedValue(delta([fileEntry()]));

    await runDriveWatchSync('tenant-1', access(), row({ cursor: null }));

    const reconcile = eventsOfType('reconcile.drive');
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0]![2]).toMatchObject({ provider: 'sharepoint', driveId: 'drive-1' });
    // Same ordering key as the ingests, so lane FIFO puts it last.
    expect(reconcile[0]![3]).toBe('sharepoint/drive-1');
    // And it carries the SAME epoch the ingests were stamped with, or it
    // would delete everything the round just wrote.
    const ingestEpoch = eventsOfType('ingest.document')[0]![2].syncEpoch;
    expect(reconcile[0]![2].syncEpoch).toBe(ingestEpoch);
  });

  it('does not reconcile a capped first round, which has not seen everything', async () => {
    mockRunDeltaRound.mockResolvedValue(
      delta([fileEntry()], { deltaLink: null, nextLink: 'https://graph/page-2' })
    );

    await runDriveWatchSync('tenant-1', access(), row({ cursor: null }));

    expect(eventsOfType('reconcile.drive')).toHaveLength(0);
  });

  it('does not reconcile an incremental round', async () => {
    mockRunDeltaRound.mockResolvedValue(delta([fileEntry()]));
    await runDriveWatchSync('tenant-1', access(), row({ cursor: 'https://graph/delta?token=abc' }));
    expect(eventsOfType('reconcile.drive')).toHaveLength(0);
  });

  it('writes the cursor and counters last, together', async () => {
    mockRunDeltaRound.mockResolvedValue(delta([fileEntry()]));

    await runDriveWatchSync('tenant-1', access(), row());

    // A crash before this point replays into idempotent enqueues; advancing
    // the cursor first would skip unprocessed items permanently.
    expect(written).toMatchObject({
      cursor: 'https://graph/delta?token=next',
      last_run_items: 1,
      sync_status: 'idle',
      last_error: null,
    });
  });
});
