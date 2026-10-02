/**
 * The rollout sweep for per-user keys (docs/user-encryption-keys-design.md):
 * give every chat and project a key and move their rows under it, move
 * every person's own memory under their key, and move every person's
 * connector credential under their own key. Batched and resumable —
 * killing it mid-run loses nothing but progress, and a row already under
 * its target key is skipped, so it can run again any time.
 *
 * THIS IS THE ONE READER OF THE RETIRED FORMS. The application opens only
 * the keyed envelopes (`renc2` on chat and project rows, `uenc1` on a
 * person's values); a row still in the old deployment-key form (`renc1`,
 * bare secretbox) or in plaintext renders as "content unavailable" / does
 * not open until this sweep has moved it. Run it as part of the deploy
 * that ships strict readers, from packages/user-keys, with DATABASE_URL
 * and the keys set (the master chain: USER_KEY_ENCRYPTION_KEY, else
 * CONTENT_ENCRYPTION_KEY, else TOKEN_ENCRYPTION_KEY; the content key for
 * the `renc1` rows; and TOKEN_ENCRYPTION_KEY for the credentials):
 *
 *   DATABASE_URL=postgres://… pnpm rekey-chats            # chats only
 *   DATABASE_URL=postgres://… pnpm rekey-chats --connectors
 *   DATABASE_URL=postgres://… pnpm rekey-chats --all
 *
 * A chat's or project's key is wrapped for its owner and for everyone the
 * resource is currently shared with; an owner with no salt yet gets one.
 * `chat_summaries.content` predates both envelopes and may be plaintext:
 * such a row is sealed too.
 */

import type { Kysely } from 'kysely';
import { getDatabase, closeDatabase, type DB } from '@renkei/db';
import {
  contentEncryptionKey,
  decryptContent,
  encryptWithResourceKey,
  isEncryptedContent,
  isResourceEncrypted,
  isUserSealed,
  parseEncryptionKey,
  decrypt,
  RESOURCE_ENVELOPE_PREFIX,
  USER_ENVELOPE_PREFIX,
} from '@renkei/crypto';
import { ensureResourceKey, sealForSubject, shareResourceKey } from '../src/index';

const BATCH = 200;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** A `renc1` row's text, or a pre-envelope plaintext (summaries only); null when it cannot be opened. */
function openLegacy(stored: string, contentKey: Buffer, plaintextAllowed: boolean): string | null {
  if (isEncryptedContent(stored)) {
    const opened = decryptContent(stored, contentKey);
    return opened.ok ? opened.val : null;
  }
  return plaintextAllowed ? stored : null;
}

interface Resealer {
  reseal(stored: string | null, plaintextAllowed: boolean): string | undefined;
  rows: () => number;
  skipped: () => number;
}

/** The resource's key, minted for its owner and wrapped for its grantees; the resealer over it. */
async function resealerFor(
  db: Kysely<DB>,
  kind: 'chat' | 'chat_project',
  resource: { id: string; tenant_id: string; owner_subject: string },
  contentKey: Buffer
): Promise<Resealer | null> {
  const ref = { tenantId: resource.tenant_id, kind, resourceId: resource.id };
  const key = await ensureResourceKey(db, ref, resource.owner_subject);
  if (!key.ok) {
    console.warn(`  ${kind} ${resource.id}: no key (${key.err.type}); skipped`);
    return null;
  }
  const grantees = await db
    .selectFrom('resource_access_grants')
    .select('grantee_subject')
    .where('tenant_id', '=', resource.tenant_id)
    .where('resource_kind', '=', kind)
    .where('resource_id', '=', resource.id)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
    .execute();
  for (const grantee of grantees) {
    const shared = await shareResourceKey(db, ref, resource.owner_subject, grantee.grantee_subject);
    if (!shared.ok) {
      console.warn(
        `  ${kind} ${resource.id}: key not wrapped for ${grantee.grantee_subject} (${shared.err.type})`
      );
    }
  }
  let rows = 0;
  let skipped = 0;
  return {
    reseal: (stored, plaintextAllowed) => {
      if (stored === null || isResourceEncrypted(stored)) return undefined;
      const text = openLegacy(stored, contentKey, plaintextAllowed);
      if (text === null) {
        skipped += 1;
        return undefined;
      }
      rows += 1;
      return encryptWithResourceKey(text, key.val.id, key.val.key);
    },
    rows: () => rows,
    skipped: () => skipped,
  };
}

/** The files of a chat or a project: their extracted text under the home's key. */
async function resealAttachments(
  db: Kysely<DB>,
  home: { chat_id: string } | { project_id: string },
  resealer: Resealer
): Promise<void> {
  let query = db
    .selectFrom('chat_attachments')
    .select(['id', 'extracted_text'])
    .where('extracted_text', 'is not', null)
    .where('extracted_text', 'not like', `${RESOURCE_ENVELOPE_PREFIX}%`);
  query =
    'chat_id' in home
      ? query.where('chat_id', '=', home.chat_id)
      : query.where('project_id', '=', home.project_id);
  for (const row of await query.execute()) {
    const next = resealer.reseal(row.extracted_text, false);
    if (next !== undefined) {
      await db
        .updateTable('chat_attachments')
        .set({ extracted_text: next })
        .where('id', '=', row.id)
        .execute();
    }
  }
}

async function rekeyChat(
  db: Kysely<DB>,
  chat: { id: string; tenant_id: string; owner_subject: string },
  contentKey: Buffer
): Promise<{ rows: number; skipped: number }> {
  const resealer = await resealerFor(db, 'chat', chat, contentKey);
  if (!resealer) return { rows: 0, skipped: 1 };
  const reseal = resealer.reseal;

  const messages = await db
    .selectFrom('chat_messages')
    .select(['id', 'content'])
    .where('chat_id', '=', chat.id)
    .where('content', 'not like', `${RESOURCE_ENVELOPE_PREFIX}%`)
    .execute();
  for (const row of messages) {
    const next = reseal(row.content, false);
    if (next !== undefined) {
      await db
        .updateTable('chat_messages')
        .set({ content: next })
        .where('id', '=', row.id)
        .execute();
    }
  }

  const summaries = await db
    .selectFrom('chat_summaries')
    .select(['id', 'content'])
    .where('chat_id', '=', chat.id)
    .where('content', 'not like', `${RESOURCE_ENVELOPE_PREFIX}%`)
    .execute();
  for (const row of summaries) {
    const next = reseal(row.content, true);
    if (next !== undefined) {
      await db
        .updateTable('chat_summaries')
        .set({ content: next })
        .where('id', '=', row.id)
        .execute();
    }
  }

  const runs = await db
    .selectFrom('chat_subagent_runs')
    .select(['id', 'task', 'instructions', 'transcript', 'report'])
    .where('chat_id', '=', chat.id)
    .where('task', 'not like', `${RESOURCE_ENVELOPE_PREFIX}%`)
    .execute();
  for (const row of runs) {
    const task = reseal(row.task, false);
    const instructions = reseal(row.instructions, false);
    const transcript = reseal(row.transcript, false);
    const report = reseal(row.report, false);
    if ([task, instructions, transcript, report].every((value) => value === undefined)) continue;
    await db
      .updateTable('chat_subagent_runs')
      .set({
        ...(task !== undefined ? { task } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
        ...(transcript !== undefined ? { transcript } : {}),
        ...(report !== undefined ? { report } : {}),
      })
      .where('id', '=', row.id)
      .execute();
  }
  await resealAttachments(db, { chat_id: chat.id }, resealer);
  return { rows: resealer.rows(), skipped: resealer.skipped() };
}

/** A project: its instructions, its memory, and its files under the project's key. */
async function rekeyProject(
  db: Kysely<DB>,
  project: { id: string; tenant_id: string; owner_subject: string; instructions: string | null },
  contentKey: Buffer
): Promise<{ rows: number; skipped: number }> {
  const resealer = await resealerFor(db, 'chat_project', project, contentKey);
  if (!resealer) return { rows: 0, skipped: 1 };
  const instructions = resealer.reseal(project.instructions, false);
  if (instructions !== undefined) {
    await db
      .updateTable('chat_projects')
      .set({ instructions })
      .where('id', '=', project.id)
      .execute();
  }
  const memories = await db
    .selectFrom('chat_project_memories')
    .select(['id', 'content'])
    .where('project_id', '=', project.id)
    .where('content', 'not like', `${RESOURCE_ENVELOPE_PREFIX}%`)
    .execute();
  for (const row of memories) {
    const next = resealer.reseal(row.content, false);
    if (next !== undefined) {
      await db
        .updateTable('chat_project_memories')
        .set({ content: next })
        .where('id', '=', row.id)
        .execute();
    }
  }
  await resealAttachments(db, { project_id: project.id }, resealer);
  return { rows: resealer.rows(), skipped: resealer.skipped() };
}

async function rekeyProjects(db: Kysely<DB>, contentKey: Buffer): Promise<void> {
  const projects = await db
    .selectFrom('chat_projects')
    .select(['id', 'tenant_id', 'owner_subject', 'instructions'])
    .orderBy('id', 'asc')
    .execute();
  let rows = 0;
  let skipped = 0;
  for (const project of projects) {
    const done = await rekeyProject(db, project, contentKey);
    rows += done.rows;
    skipped += done.skipped;
  }
  console.log(
    `projects: ${projects.length} keyed, ${rows} row(s) re-sealed, ${skipped} row(s) skipped.`
  );
}

/** A person's own memory: `renc1` rows moved directly under the person's key. */
async function rekeyUserMemories(db: Kysely<DB>, contentKey: Buffer): Promise<void> {
  const rows = await db
    .selectFrom('chat_user_memories')
    .select(['id', 'tenant_id', 'owner_subject', 'content'])
    .where('content', 'not like', `${USER_ENVELOPE_PREFIX}%`)
    .execute();
  let moved = 0;
  for (const row of rows) {
    const text = openLegacy(row.content, contentKey, false);
    if (text === null) continue;
    const sealed = await sealForSubject(db, row.tenant_id, row.owner_subject, text);
    if (!sealed.ok) continue;
    await db
      .updateTable('chat_user_memories')
      .set({ content: sealed.val })
      .where('id', '=', row.id)
      .execute();
    moved += 1;
  }
  console.log(
    `chat_user_memories: ${moved} of ${rows.length} row(s) moved under their owner's key.`
  );
}

async function rekeyChats(db: Kysely<DB>): Promise<void> {
  const contentKeyResult = contentEncryptionKey();
  if (!contentKeyResult.ok)
    fail(`No content key for the renc1 rows: ${contentKeyResult.err.message}`);
  const contentKey = contentKeyResult.val;

  let after: string | null = null;
  let chats = 0;
  let rows = 0;
  let skipped = 0;
  for (;;) {
    let query = db
      .selectFrom('chats')
      .select(['id', 'tenant_id', 'owner_subject'])
      .orderBy('id', 'asc')
      .limit(BATCH);
    if (after) query = query.where('id', '>', after);
    const batch = await query.execute();
    if (batch.length === 0) break;
    for (const chat of batch) {
      const done = await rekeyChat(db, chat, contentKey);
      rows += done.rows;
      skipped += done.skipped;
      chats += 1;
    }
    after = batch[batch.length - 1]!.id;
    console.log(`chats: ${chats} keyed, ${rows} row(s) re-sealed, ${skipped} skipped…`);
  }
  console.log(
    `Done — ${chats} chat(s) keyed, ${rows} row(s) re-sealed, ${skipped} row(s) skipped.`
  );
  await rekeyProjects(db, contentKey);
  await rekeyUserMemories(db, contentKey);
}

/** One credential table: every row not yet under its owner's key, re-sealed. */
async function rekeyCredentials(
  db: Kysely<DB>,
  table: 'mirth_instance_connections' | 'admanager_instance_connections' | 'file_share_connections',
  legacyKey: Buffer
): Promise<void> {
  const rows = await db
    .selectFrom(table)
    .select(['tenant_id', 'subject', 'encrypted_credentials'])
    .where('encrypted_credentials', 'not like', `${USER_ENVELOPE_PREFIX}%`)
    .execute();
  let moved = 0;
  for (const row of rows) {
    const opened = decrypt(row.encrypted_credentials, legacyKey);
    if (!opened.ok) {
      console.warn(
        `  ${table}: a row for ${row.subject} did not open under the legacy key; skipped`
      );
      continue;
    }
    const sealed = await sealForSubject(db, row.tenant_id, row.subject, opened.val);
    if (!sealed.ok) {
      console.warn(`  ${table}: ${row.subject} could not be sealed (${sealed.err.type}); skipped`);
      continue;
    }
    await db
      .updateTable(table)
      .set({ encrypted_credentials: sealed.val })
      .where('tenant_id', '=', row.tenant_id)
      .where('subject', '=', row.subject)
      .where('encrypted_credentials', '=', row.encrypted_credentials)
      .execute();
    moved += 1;
  }
  console.log(`${table}: ${moved} of ${rows.length} row(s) moved under their owner's key.`);
}

async function rekeyProviderGrants(db: Kysely<DB>, legacyKey: Buffer): Promise<void> {
  const rows = await db
    .selectFrom('provider_grants')
    .select([
      'tenant_id',
      'provider',
      'provider_account_id',
      'subject',
      'encrypted_access_token',
      'encrypted_refresh_token',
    ])
    .where('subject', 'is not', null)
    .where((eb) =>
      eb.or([
        eb('encrypted_access_token', 'not like', `${USER_ENVELOPE_PREFIX}%`),
        eb('encrypted_refresh_token', 'not like', `${USER_ENVELOPE_PREFIX}%`),
      ])
    )
    .execute();
  let moved = 0;
  for (const row of rows) {
    if (!row.subject) continue;
    const next: { encrypted_access_token?: string; encrypted_refresh_token?: string } = {};
    let broken = false;
    for (const column of ['encrypted_access_token', 'encrypted_refresh_token'] as const) {
      const stored = row[column];
      if (isUserSealed(stored)) continue;
      const opened = decrypt(stored, legacyKey);
      if (!opened.ok) {
        broken = true;
        break;
      }
      const sealed = await sealForSubject(db, row.tenant_id, row.subject, opened.val);
      if (!sealed.ok) {
        broken = true;
        break;
      }
      next[column] = sealed.val;
    }
    if (broken) {
      console.warn(
        `  provider_grants: ${row.provider}/${row.provider_account_id} did not open or seal; skipped`
      );
      continue;
    }
    await db
      .updateTable('provider_grants')
      .set(next)
      .where('tenant_id', '=', row.tenant_id)
      .where('provider', '=', row.provider)
      .where('provider_account_id', '=', row.provider_account_id)
      .execute();
    moved += 1;
  }
  console.log(`provider_grants: ${moved} of ${rows.length} row(s) moved under their owner's key.`);
}

async function rekeyConnectors(db: Kysely<DB>): Promise<void> {
  const legacy = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!legacy.ok) fail('TOKEN_ENCRYPTION_KEY (the legacy credential key) is not set or malformed.');
  await rekeyProviderGrants(db, legacy.val);
  await rekeyCredentials(db, 'mirth_instance_connections', legacy.val);
  await rekeyCredentials(db, 'admanager_instance_connections', legacy.val);
  await rekeyCredentials(db, 'file_share_connections', legacy.val);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const all = args.has('--all');
  const connectors = all || args.has('--connectors');
  const chats = all || !args.has('--connectors');

  const dbResult = getDatabase();
  if (!dbResult.ok) fail('Database unavailable — set DATABASE_URL.');
  const db = dbResult.val;

  if (chats) await rekeyChats(db);
  if (connectors) await rekeyConnectors(db);
  await closeDatabase();
}

void main();
