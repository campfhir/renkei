/**
 * loadCodeProjectUsage against a real database (skipped without
 * DATABASE_URL): sums `chat_turns` across every turn of every chat in a
 * project — several turns per chat, several chats — and never reaches
 * outside the project it was asked about.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { loadCodeProjectUsage } from './usage';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('loadCodeProjectUsage', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const subject = `owner-${tenantId.slice(0, 8)}`;
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const chatA = randomUUID();
  const chatB = randomUUID();
  const chatOutside = randomUUID();

  const turn = (chatId: string, inputTokens: number, outputTokens: number) =>
    db
      .insertInto('chat_turns')
      .values({
        tenant_id: tenantId,
        chat_id: chatId,
        status: 'completed',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      })
      .execute();

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `code-usage-${tenantId.slice(0, 8)}` })
      .execute();
    for (const id of [projectId, otherProjectId]) {
      await db
        .insertInto('chat_projects')
        .values({ id, tenant_id: tenantId, owner_subject: subject, name: 'p', kind: 'code' })
        .execute();
    }
    for (const [id, projectFk] of [
      [chatA, projectId],
      [chatB, projectId],
      [chatOutside, otherProjectId],
    ] as const) {
      await db
        .insertInto('chats')
        .values({ id, tenant_id: tenantId, owner_subject: subject, project_id: projectFk })
        .execute();
    }
    // Chat A: two turns — an orchestrator's own call, then a turn whose
    // total also carries what its sub-agents cost (turn-runner.ts folds
    // code_delegate usage into the same total before this row is written).
    await turn(chatA, 1_000, 200);
    await turn(chatA, 5_000, 900);
    // Chat B: one turn.
    await turn(chatB, 300, 50);
    // A chat in a different project — never counted here.
    await turn(chatOutside, 10_000, 10_000);
  });

  afterAll(async () => {
    await sql`DELETE FROM chat_turns WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chats WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM chat_projects WHERE tenant_id = ${tenantId}`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
  });

  it('sums every turn per chat, and the project total across every chat', async () => {
    const usage = await loadCodeProjectUsage(db, tenantId, projectId);
    expect(usage.byChat[chatA]).toEqual({ inputTokens: 6_000, outputTokens: 1_100 });
    expect(usage.byChat[chatB]).toEqual({ inputTokens: 300, outputTokens: 50 });
    expect(usage.byChat[chatOutside]).toBeUndefined();
    expect(usage.total).toEqual({ inputTokens: 6_300, outputTokens: 1_150 });
  });

  it('answers empty for a project with no turns', async () => {
    const empty = await loadCodeProjectUsage(db, tenantId, randomUUID());
    expect(empty).toEqual({ total: { inputTokens: 0, outputTokens: 0 }, byChat: {} });
  });
});
