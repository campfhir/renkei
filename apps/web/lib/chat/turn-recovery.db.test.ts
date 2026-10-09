/**
 * The claim half of turn recovery against a real database (skipped
 * without DATABASE_URL): a suspended turn is claimed at once, a running
 * one with a fresh heartbeat is left alone, a stale heartbeat counts as
 * suspended, a claim is exclusive across two sweeps, and a turn past its
 * resume budget is ended instead — with its streaming rows.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { claimResumableTurns, interruptExhaustedTurns, suspendTurn, getTurn } from './turns';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('turn recovery claims', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const subject = `owner-${tenantId.slice(0, 8)}`;

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db.insertInto('tenants').values({ id: tenantId, slug: tenantId }).execute();
  });

  afterAll(async () => {
    await db.deleteFrom('tenants').where('id', '=').execute();
    await closeDatabase();
  });

  async function chat(): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('chats')
      .values({ id, owner_subject: subject })
      .execute();
    return id;
  }

  async function turn(chatId: string, over: { resume_count?: number } = {}): Promise<string> {
    const inserted = await db
      .insertInto('chat_turns')
      .values({
        chat_id: chatId,
        status: 'running',
        kind: 'reply',
        llm_model_id: null,
        thinking_budget: null,
        runner: JSON.stringify({ roles: ['member'], voice: false }),
        ...over,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  const options = { staleSeconds: 60, maxResumes: 3, limit: 10 };

  it('claims a suspended turn once, clearing the mark and counting the resume', async () => {
    const turnId = await turn(await chat());
    expect(await claimResumableTurns(db, options)).toEqual([]);
    await suspendTurn(db, turnId, 4);
    const claimed = await claimResumableTurns(db, options);
    expect(claimed.map((row) => row.id)).toEqual([turnId]);
    expect(claimed[0]).toMatchObject({
      status: 'running',
      iterations: 4,
      resumeCount: 1,
      suspendedAt: null,
      runner: { roles: ['member'], voice: false },
    });
    // Claimed: its heartbeat is fresh and its mark gone, so nobody else takes it.
    expect(await claimResumableTurns(db, options)).toEqual([]);
  });

  it('treats a stale heartbeat as a dead process, and a live one as running', async () => {
    const turnId = await turn(await chat());
    await db
      .updateTable('chat_turns')
      .set({ updated_at: sql`NOW() - INTERVAL '2 minutes'` })
      .where('id', '=', turnId)
      .execute();
    const claimed = await claimResumableTurns(db, options);
    expect(claimed.map((row) => row.id)).toEqual([turnId]);
    expect(claimed[0]?.resumeCount).toBe(1);
  });

  it('never claims a compaction turn or a settled one', async () => {
    const chatId = await chat();
    const compaction = await db
      .insertInto('chat_turns')
      .values({
        chat_id: chatId,
        status: 'running',
        kind: 'compaction',
        llm_model_id: null,
        thinking_budget: null,
        suspended_at: sql`NOW()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const done = await turn(await chat());
    await db
      .updateTable('chat_turns')
      .set({ status: 'completed', suspended_at: sql`NOW()` })
      .where('id', '=', done)
      .execute();
    const ids = (await claimResumableTurns(db, options)).map((row) => row.id);
    expect(ids).not.toContain(compaction.id);
    expect(ids).not.toContain(done);
  });

  it('ends a turn past its resume budget as interrupted, with its streaming rows', async () => {
    const chatId = await chat();
    const turnId = await turn(chatId, { resume_count: 3 });
    const message = await db
      .insertInto('chat_messages')
      .values({
        chat_id: chatId,
        turn_id: turnId,
        seq: 1,
        role: 'assistant',
        kind: 'assistant',
        status: 'streaming',
        content: '',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await suspendTurn(db, turnId, 9);
    expect((await claimResumableTurns(db, options)).map((row) => row.id)).not.toContain(turnId);
    const ended = await interruptExhaustedTurns(db, { ...options, error: 'too many' });
    expect(ended).toContain(turnId);
    const after = await getTurn(db, chatId, turnId);
    expect(after).toMatchObject({ status: 'interrupted', error: 'too many', suspendedAt: null });
    const row = await db
      .selectFrom('chat_messages')
      .select('status')
      .where('id', '=', message.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('interrupted');
  });
});
