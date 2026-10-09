/**
 * The PHI access trail against a real database (skipped without
 * DATABASE_URL): a row lands with ids only, the run id is taken from the
 * call's context only for an agent's call, the table refuses UPDATE and
 * DELETE whoever asks, and the operator's listing comes back newest first
 * for one person.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { hashPath, listPhiAccessEvents, recordPhiAccess } from './phi-access';
import { withRun } from './mcp-tools/run-context';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('phi_access_events', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const alice = `alice-${tenantId.slice(0, 8)}`;
  const bob = `bob-${tenantId.slice(0, 8)}`;

  beforeAll(async () => {
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    db = dbResult.val;
  });

  afterAll(async () => {
    // The trail is append-only even here: the tenant's cascade is the one
    // way its rows go, which is also what offboarding an org does.
    await sql`ALTER TABLE phi_access_events DISABLE TRIGGER phi_access_events_no_update_delete`.execute(
      db
    );
    await db.deleteFrom('phi_access_events').execute();
    await sql`ALTER TABLE phi_access_events ENABLE TRIGGER phi_access_events_no_update_delete`.execute(
      db
    );
  });

  it("records a person's read with ids only, and an agent's with the run it belongs to", async () => {
    const runId = randomUUID();
    const agentId = randomUUID();
    expect(
      await recordPhiAccess(
        {
          subject: alice,
          connector: 'mirth',
          instanceId: randomUUID(),
          action: 'read',
          toolName: 'mirth_get_message',
          channelId: 'c1',
          messageId: 4711,
        },
        db
      )
    ).toBe(true);
    // A person's own call inside a run context (impossible in practice;
    // the header is the runner's) still records no run.
    await withRun(runId, () =>
      recordPhiAccess(
        {
          subject: alice,
          connector: 'onbase',
          action: 'read',
          toolName: 'onbase_read_document',
          documentId: '9001',
        },
        db
      )
    );
    await withRun(runId, () =>
      recordPhiAccess(
        {
          subject: alice,
          agentId,
          connector: 'fileshare',
          instanceId: randomUUID(),
          action: 'download',
          toolName: 'fileshare_download_file',
          pathHash: hashPath('/patients/doe.pdf'),
        },
        db
      )
    );
    const rows = await listPhiAccessEvents(db, { subject: alice });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.toolName)).toEqual([
      'fileshare_download_file',
      'onbase_read_document',
      'mirth_get_message',
    ]);
    expect(rows[0]).toMatchObject({
      agentId,
      runId,
      action: 'download',
      pathHash: hashPath('/patients/doe.pdf'),
    });
    expect(rows[1]).toMatchObject({ agentId: null, runId: null, documentId: '9001' });
    expect(rows[2]).toMatchObject({ channelId: 'c1', messageId: '4711', connector: 'mirth' });
    expect(JSON.stringify(rows)).not.toContain('/patients');
  });

  it('is append-only: UPDATE and DELETE are refused by the table itself', async () => {
    await recordPhiAccess(
      {
        subject: bob,
        connector: 'onbase',
        action: 'search',
        toolName: 'onbase_search_documents',
        documentId: 'DocumentType:7',
      },
      db
    );
    await expect(
      db
        .updateTable('phi_access_events')
        .set({ subject: alice })
        .execute()
    ).rejects.toThrow(/append-only/);
    await expect(
      db
        .deleteFrom('phi_access_events')
        .where('subject', '=', bob)
        .execute()
    ).rejects.toThrow(/append-only/);
    const bobs = await listPhiAccessEvents(db, { subject: bob });
    expect(bobs).toHaveLength(1);
    // The listing is per person: Alice's rows are not Bob's.
    expect((await listPhiAccessEvents(db)).length).toBe(4);
  });

  it('refuses a connector or action outside the vocabulary', async () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const bad = {
      subject: bob,
      connector: 'jira',
      action: 'read',
      toolName: 'jira_get_issue',
    } as unknown as Parameters<typeof recordPhiAccess>[0];
    expect(await recordPhiAccess(bad, db)).toBe(false);
  });
});
