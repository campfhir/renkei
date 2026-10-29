/**
 * The PHI access trail against a real database (skipped without
 * DATABASE_URL): a row lands with ids only, the run id is taken from the
 * call's context only for an agent's call, and the operator's listing
 * comes back newest first for one person. The trail is append-only (the
 * table's trigger refuses UPDATE and DELETE); the store offers no way to
 * change or remove a row, so the subjects here are per run and their rows
 * stay, as every real row does.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore } from '@renkei/db';
import { hashPath, listPhiAccessEvents, recordPhiAccess } from './phi-access';
import { withRun } from './mcp-tools/run-context';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('phi_access_events', () => {
  const suiteId = randomUUID();
  const alice = `alice-${suiteId.slice(0, 8)}`;
  const bob = `bob-${suiteId.slice(0, 8)}`;

  afterAll(async () => {
    await closeDataStore();
  });

  it("records a person's read with ids only, and an agent's with the run it belongs to", async () => {
    const runId = randomUUID();
    const agentId = randomUUID();
    expect(
      await recordPhiAccess({
        subject: alice,
        connector: 'mirth',
        instanceId: randomUUID(),
        action: 'read',
        toolName: 'mirth_get_message',
        channelId: 'c1',
        messageId: 4711,
      })
    ).toBe(true);
    // A person's own call inside a run context (impossible in practice;
    // the header is the runner's) still records no run.
    await withRun(runId, () =>
      recordPhiAccess({
        subject: alice,
        connector: 'onbase',
        action: 'read',
        toolName: 'onbase_read_document',
        documentId: '9001',
      })
    );
    await withRun(runId, () =>
      recordPhiAccess({
        subject: alice,
        agentId,
        connector: 'fileshare',
        instanceId: randomUUID(),
        action: 'download',
        toolName: 'fileshare_download_file',
        pathHash: hashPath('/patients/doe.pdf'),
      })
    );
    const rows = await listPhiAccessEvents({ subject: alice });
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

  it("keeps one person's trail apart from another's", async () => {
    await recordPhiAccess({
      subject: bob,
      connector: 'onbase',
      action: 'search',
      toolName: 'onbase_search_documents',
      documentId: 'DocumentType:7',
    });
    const bobs = await listPhiAccessEvents({ subject: bob });
    expect(bobs).toHaveLength(1);
    expect(bobs[0]).toMatchObject({ subject: bob, toolName: 'onbase_search_documents' });
    // The listing is per person: Alice's rows are not Bob's, and the
    // unfiltered listing holds both.
    expect(await listPhiAccessEvents({ subject: alice })).toHaveLength(3);
    const everyone = await listPhiAccessEvents({ limit: 500 });
    expect(everyone.filter((row) => row.subject === alice || row.subject === bob)).toHaveLength(4);
  });

  it('refuses a connector or action outside the vocabulary', async () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const bad = {
      subject: bob,
      connector: 'jira',
      action: 'read',
      toolName: 'jira_get_issue',
    } as unknown as Parameters<typeof recordPhiAccess>[0];
    expect(await recordPhiAccess(bad)).toBe(false);
  });
});
