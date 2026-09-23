/**
 * One active chat per code project, against a real database (skipped
 * without DATABASE_URL): a new chat in a code project becomes its active
 * chat and the previous one history; not while the previous one is
 * mid-reply; archiving the active chat releases it and deleting it clears
 * the reference; a chat project keeps no active chat at all.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { getProjectRow } from '@/lib/chat/projects';
import { createChatInProject, isHistoryChat, releaseActiveChat } from './active-chat';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('code project active chat', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
  const subject = `owner-${tenantId.slice(0, 8)}`;
  const codeProjectId = randomUUID();
  const chatProjectId = randomUUID();

  const input = {
    tenantId,
    ownerSubject: subject,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
  };

  beforeAll(async () => {
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db.insertInto('tenants').values({ id: tenantId, slug: tenantId }).execute();
    await db
      .insertInto('chat_projects')
      .values([
        {
          id: codeProjectId,
          tenant_id: tenantId,
          owner_subject: subject,
          name: 'Code',
          kind: 'code',
          repo_provider: 'atlassian-bitbucket',
          repo_full_name: 'acme/billing',
          repo_branch: 'main',
        },
        { id: chatProjectId, tenant_id: tenantId, owner_subject: subject, name: 'Chat' },
      ])
      .execute();
  });

  afterAll(async () => {
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await closeDatabase();
  });

  it('makes each new chat the active one and the previous one history', async () => {
    const first = await createChatInProject(db, { ...input, projectId: codeProjectId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    let project = await getProjectRow(db, tenantId, codeProjectId);
    expect(project?.activeChatId).toBe(first.val);
    expect(isHistoryChat(project, first.val)).toBe(false);

    const second = await createChatInProject(db, { ...input, projectId: codeProjectId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    project = await getProjectRow(db, tenantId, codeProjectId);
    expect(project?.activeChatId).toBe(second.val);
    expect(isHistoryChat(project, first.val)).toBe(true);
    expect(isHistoryChat(project, second.val)).toBe(false);
  });

  it('refuses a new chat while the active chat is replying', async () => {
    const before = await getProjectRow(db, tenantId, codeProjectId);
    const active = before?.activeChatId;
    expect(active).toBeTruthy();
    if (!active) return;
    const turn = await db
      .insertInto('chat_turns')
      .values({ tenant_id: tenantId, chat_id: active, status: 'running' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const refused = await createChatInProject(db, { ...input, projectId: codeProjectId });
    expect(refused).toEqual({ ok: false, err: { type: 'TURN_RUNNING' } });
    const after = await getProjectRow(db, tenantId, codeProjectId);
    expect(after?.activeChatId).toBe(active);

    await db
      .updateTable('chat_turns')
      .set({ status: 'completed' })
      .where('id', '=', turn.id)
      .execute();
    const allowed = await createChatInProject(db, { ...input, projectId: codeProjectId });
    expect(allowed.ok).toBe(true);
  });

  it('releases the active chat on archive and clears it on delete; never revives an earlier one', async () => {
    const current = (await getProjectRow(db, tenantId, codeProjectId))?.activeChatId;
    expect(current).toBeTruthy();
    if (!current) return;

    // Releasing some other chat changes nothing.
    await releaseActiveChat(db, tenantId, randomUUID());
    expect((await getProjectRow(db, tenantId, codeProjectId))?.activeChatId).toBe(current);

    await releaseActiveChat(db, tenantId, current);
    let project = await getProjectRow(db, tenantId, codeProjectId);
    expect(project?.activeChatId).toBeNull();
    // Nothing may continue now — the released chat included.
    expect(isHistoryChat(project, current)).toBe(true);

    const next = await createChatInProject(db, { ...input, projectId: codeProjectId });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    await db.deleteFrom('chats').where('id', '=', next.val).execute();
    project = await getProjectRow(db, tenantId, codeProjectId);
    expect(project?.activeChatId).toBeNull();
  });

  it('leaves a chat project alone', async () => {
    const first = await createChatInProject(db, { ...input, projectId: chatProjectId });
    const second = await createChatInProject(db, { ...input, projectId: chatProjectId });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const project = await getProjectRow(db, tenantId, chatProjectId);
    expect(project?.activeChatId).toBeNull();
    expect(isHistoryChat(project, first.val)).toBe(false);
    expect(isHistoryChat(project, second.val)).toBe(false);
  });

  it('is never history outside a project', () => {
    expect(isHistoryChat(null, randomUUID())).toBe(false);
  });
});
