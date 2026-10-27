/**
 * The claim half of turn recovery against a real database (skipped
 * without DATABASE_URL): a suspended turn is claimed at once, a running
 * one with a fresh heartbeat is left alone, a stale heartbeat counts as
 * suspended, a claim is exclusive across two sweeps, and a turn past its
 * resume budget is ended instead — with its streaming rows.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeDataStore, getDataStore } from '@renkei/db';
import { claimResumableTurns, interruptExhaustedTurns, suspendTurn, getTurn } from './turns';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('turn recovery claims', () => {
  const suiteId = randomUUID();
  const subject = `owner-${suiteId.slice(0, 8)}`;
  const chats: string[] = [];

  afterAll(async () => {
    // A chat's turns and messages go with it.
    const store = getDataStore();
    for (const chatId of chats) await store.chats.delete(subject, chatId);
    await closeDataStore();
  });

  async function chat(): Promise<string> {
    const id = await getDataStore().chats.create({
      ownerSubject: subject,
      projectId: null,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });
    chats.push(id);
    return id;
  }

  /** The turns this suite made: claims are organization-wide, so other
   *  suites' (and earlier runs') turns are filtered out of every answer. */
  const options = { staleSeconds: 60, maxResumes: 3, limit: 100 };
  const mine = new Set<string>();
  const claim = async (staleSeconds = options.staleSeconds) =>
    (await claimResumableTurns({ ...options, staleSeconds })).filter((row) => mine.has(row.id));

  async function turn(chatId: string, kind = 'reply'): Promise<string> {
    const id = await getDataStore().chatThreads.createTurn({
      chatId,
      kind,
      llmModelId: null,
      thinkingBudget: null,
      runner: { roles: ['member'], voice: false },
    });
    mine.add(id);
    return id;
  }

  it('claims a suspended turn once, clearing the mark and counting the resume', async () => {
    const turnId = await turn(await chat());
    expect(await claim()).toEqual([]);
    await suspendTurn(turnId, 4);
    const claimed = await claim();
    expect(claimed.map((row) => row.id)).toEqual([turnId]);
    expect(claimed[0]).toMatchObject({
      status: 'running',
      iterations: 4,
      resumeCount: 1,
      suspendedAt: null,
      runner: { roles: ['member'], voice: false },
    });
    // Claimed: its heartbeat is fresh and its mark gone, so nobody else takes it.
    expect(await claim()).toEqual([]);
  });

  it('treats a stale heartbeat as a dead process, and a live one as running', async () => {
    const chatId = await chat();
    const turnId = await turn(chatId);
    // A live heartbeat: left alone.
    expect((await claim()).map((row) => row.id)).not.toContain(turnId);
    // Its heartbeat older than the sweep's threshold (a second, here,
    // rather than a minute): taken as a dead process's turn.
    await sleep(1_200);
    const claimed = (await claim(1)).filter((row) => row.id === turnId);
    expect(claimed.map((row) => row.id)).toEqual([turnId]);
    expect(claimed[0]?.resumeCount).toBe(1);
    expect((await getTurn(chatId, turnId))?.resumeCount).toBe(1);
  });

  it('never claims a compaction turn or a settled one', async () => {
    const compaction = await turn(await chat(), 'compaction');
    await suspendTurn(compaction, 0);
    const done = await turn(await chat());
    await suspendTurn(done, 1);
    await getDataStore().chatThreads.finishTurn(done, {
      status: 'completed',
      error: null,
      iterations: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    const ids = (await claim()).map((row) => row.id);
    expect(ids).not.toContain(compaction);
    expect(ids).not.toContain(done);
  });

  it('ends a turn past its resume budget as interrupted, with its streaming rows', async () => {
    const chatId = await chat();
    const turnId = await turn(chatId);
    const message = await getDataStore().chatThreads.insertMessage({
      chatId,
      turnId,
      role: 'assistant',
      kind: 'assistant',
      status: 'streaming',
      content: '',
    });
    // Resumed as many times as the budget allows: lost and claimed back three times.
    for (let resumes = 1; resumes <= options.maxResumes; resumes += 1) {
      await suspendTurn(turnId, resumes);
      const claimed = (await claim()).filter((row) => row.id === turnId);
      expect(claimed.map((row) => row.resumeCount)).toEqual([resumes]);
    }
    await suspendTurn(turnId, 9);
    expect((await claim()).map((row) => row.id)).not.toContain(turnId);
    const ended = await interruptExhaustedTurns({ ...options, error: 'too many' });
    expect(ended).toContain(turnId);
    const after = await getTurn(chatId, turnId);
    expect(after).toMatchObject({ status: 'interrupted', error: 'too many', suspendedAt: null });
    const row = await getDataStore().chatThreads.getMessage(chatId, message.id);
    expect(row?.status).toBe('interrupted');
  });
});
