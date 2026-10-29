/**
 * loadCodeProjectUsage against a real database (skipped without
 * DATABASE_URL): sums `chat_turns` across every turn of every chat in a
 * project — several turns per chat, several chats — and never reaches
 * outside the project it was asked about.
 */

import { randomUUID } from 'node:crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import { loadCodeProjectUsage } from './usage';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('loadCodeProjectUsage', () => {
  const suiteId = randomUUID();
  const subject = `owner-${suiteId.slice(0, 8)}`;
  let projectId = '';
  let otherProjectId = '';
  let chatA = '';
  let chatB = '';
  let chatOutside = '';

  // A finished turn, the way the turn runner leaves one: opened, then
  // settled with its token tallies.
  const turn = async (chatId: string, inputTokens: number, outputTokens: number) => {
    const store = getDataStore().chatThreads;
    const turnId = await store.createTurn({
      chatId,
      kind: 'reply',
      llmModelId: null,
      thinkingBudget: null,
      runner: null,
    });
    await store.finishTurn(turnId, {
      status: 'completed',
      error: null,
      iterations: 1,
      inputTokens,
      outputTokens,
    });
  };

  const codeProject = () =>
    getDataStore().chatProjects.create({
      ownerSubject: subject,
      name: 'p',
      description: null,
      toolConfig: null,
      repo: { provider: 'github', fullName: `acme/${suiteId}`, branch: null },
    });

  const chatIn = (projectFk: string) =>
    getDataStore().chats.create({
      ownerSubject: subject,
      projectId: projectFk,
      llmModelId: null,
      toolConfig: null,
      thinkingEnabled: false,
      autoMode: false,
    });

  beforeAll(async () => {
    projectId = await codeProject();
    otherProjectId = await codeProject();
    chatA = await chatIn(projectId);
    chatB = await chatIn(projectId);
    chatOutside = await chatIn(otherProjectId);
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
    const store = getDataStore();
    for (const chatId of [chatA, chatB, chatOutside]) await store.chats.delete(subject, chatId);
    for (const id of [projectId, otherProjectId]) await store.chatProjects.delete(subject, id);
    await closeDataStore();
  });
  it('sums every turn per chat, and the project total across every chat', async () => {
    const usage = await loadCodeProjectUsage(projectId);
    expect(usage.byChat[chatA]).toEqual({ inputTokens: 6_000, outputTokens: 1_100 });
    expect(usage.byChat[chatB]).toEqual({ inputTokens: 300, outputTokens: 50 });
    expect(usage.byChat[chatOutside]).toBeUndefined();
    expect(usage.total).toEqual({ inputTokens: 6_300, outputTokens: 1_150 });
  });

  it('answers empty for a project with no turns', async () => {
    const empty = await loadCodeProjectUsage(randomUUID());
    expect(empty).toEqual({ total: { inputTokens: 0, outputTokens: 0 }, byChat: {} });
  });
});
