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
 * resource is currently shared with, under MANAGED keys (legacy.ts): the
 * sweep runs before anyone has enrolled, and enrollment moves each
 * person's wrappings to the key they hold. A person already enrolled is
 * skipped here — their rows are theirs to move, and `enroll` did.
 * `chat_summaries.content` predates both envelopes and may be plaintext:
 * such a row is sealed too.
 *
 * The rows come and go through the data store (legacyEnvelopes); what is
 * opened and re-sealed, and under which key, is decided here.
 */

import { closeDataStore, getDataStore, type LegacyEnvelopeCredentialTable } from '@renkei/db';
import {
  contentEncryptionKey,
  decryptContent,
  encryptWithResourceKey,
  isEncryptedContent,
  isResourceEncrypted,
  isUserSealed,
  loadKeyring,
  decrypt,
  RESOURCE_ENVELOPE_PREFIX,
  USER_ENVELOPE_PREFIX,
} from '@renkei/crypto';
import {
  legacyEnsureResourceKey,
  legacySealForSubject,
  legacyShareResourceKey,
} from '../src/index';

const BATCH = 200;
const KEYED = `${RESOURCE_ENVELOPE_PREFIX}%`;
const USER_SEALED = `${USER_ENVELOPE_PREFIX}%`;

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
  kind: 'chat' | 'chat_project',
  resource: { id: string; ownerSubject: string },
  contentKey: Buffer
): Promise<Resealer | null> {
  const ref = { kind, resourceId: resource.id };
  const key = await legacyEnsureResourceKey(ref, resource.ownerSubject);
  if (!key.ok) {
    console.warn(`  ${kind} ${resource.id}: no key (${key.err.type}); skipped`);
    return null;
  }
  const grantees = await getDataStore().resourceGrants.activeGrantees(kind, resource.id);
  for (const grantee of grantees) {
    const shared = await legacyShareResourceKey(key.val, resource.ownerSubject, grantee);
    if (!shared.ok) {
      console.warn(`  ${kind} ${resource.id}: key not wrapped for ${grantee} (${shared.err.type})`);
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
  keyKind: 'chat' | 'chat_project',
  keyRef: string,
  resealer: Resealer
): Promise<void> {
  const store = getDataStore().legacyEnvelopes;
  // A row still under its chat's or project's key names it (migration 163).
  for (const row of await store.attachments(keyKind, keyRef, KEYED)) {
    const next = resealer.reseal(row.extractedText, false);
    if (next !== undefined) {
      await store.reseal({ table: 'artifacts', id: row.id, extractedText: next });
    }
  }
}

async function rekeyChat(
  chat: { id: string; ownerSubject: string },
  contentKey: Buffer
): Promise<{ rows: number; skipped: number }> {
  const resealer = await resealerFor('chat', chat, contentKey);
  if (!resealer) return { rows: 0, skipped: 1 };
  const reseal = resealer.reseal;
  const store = getDataStore().legacyEnvelopes;
  const { messages, summaries, subagentRuns } = await store.chatRows(chat.id, KEYED);

  for (const row of messages) {
    const next = reseal(row.content, false);
    if (next !== undefined) {
      await store.reseal({ table: 'chat_messages', id: row.id, content: next });
    }
  }
  for (const row of summaries) {
    const next = reseal(row.content, true);
    if (next !== undefined) {
      await store.reseal({ table: 'chat_summaries', id: row.id, content: next });
    }
  }
  for (const row of subagentRuns) {
    const task = reseal(row.task, false);
    const instructions = reseal(row.instructions, false);
    const transcript = reseal(row.transcript, false);
    const report = reseal(row.report, false);
    if ([task, instructions, transcript, report].every((value) => value === undefined)) continue;
    await store.reseal({
      table: 'chat_subagent_runs',
      id: row.id,
      task,
      instructions,
      transcript,
      report,
    });
  }
  await resealAttachments('chat', chat.id, resealer);
  return { rows: resealer.rows(), skipped: resealer.skipped() };
}

/** A project: its instructions, its memory, and its files under the project's key. */
async function rekeyProject(
  project: { id: string; ownerSubject: string; instructions: string | null },
  contentKey: Buffer
): Promise<{ rows: number; skipped: number }> {
  const resealer = await resealerFor('chat_project', project, contentKey);
  if (!resealer) return { rows: 0, skipped: 1 };
  const store = getDataStore().legacyEnvelopes;
  const instructions = resealer.reseal(project.instructions, false);
  if (instructions !== undefined) {
    await store.reseal({ table: 'chat_projects', id: project.id, instructions });
  }
  for (const row of await store.projectMemories(project.id, KEYED)) {
    const next = resealer.reseal(row.content, false);
    if (next !== undefined) {
      await store.reseal({ table: 'chat_project_memories', id: row.id, content: next });
    }
  }
  await resealAttachments('chat_project', project.id, resealer);
  return { rows: resealer.rows(), skipped: resealer.skipped() };
}

async function rekeyProjects(contentKey: Buffer): Promise<void> {
  const projects = await getDataStore().legacyEnvelopes.projects();
  let rows = 0;
  let skipped = 0;
  for (const project of projects) {
    const done = await rekeyProject(project, contentKey);
    rows += done.rows;
    skipped += done.skipped;
  }
  console.log(
    `projects: ${projects.length} keyed, ${rows} row(s) re-sealed, ${skipped} row(s) skipped.`
  );
}

/** A person's own memory: `renc1` rows moved directly under the person's key. */
async function rekeyUserMemories(contentKey: Buffer): Promise<void> {
  const store = getDataStore().legacyEnvelopes;
  const rows = await store.userMemories(USER_SEALED);
  let moved = 0;
  for (const row of rows) {
    const text = openLegacy(row.content, contentKey, false);
    if (text === null) continue;
    const sealed = await legacySealForSubject(row.ownerSubject, text);
    if (!sealed.ok) continue;
    await store.reseal({ table: 'chat_user_memories', id: row.id, content: sealed.val });
    moved += 1;
  }
  console.log(
    `chat_user_memories: ${moved} of ${rows.length} row(s) moved under their owner's key.`
  );
}

async function rekeyChats(): Promise<void> {
  const contentKeyResult = contentEncryptionKey();
  if (!contentKeyResult.ok)
    fail(`No content key for the renc1 rows: ${contentKeyResult.err.message}`);
  const contentKey = contentKeyResult.val;

  let after: string | null = null;
  let chats = 0;
  let rows = 0;
  let skipped = 0;
  for (;;) {
    const batch = await getDataStore().legacyEnvelopes.chatsPage(after, BATCH);
    if (batch.length === 0) break;
    for (const chat of batch) {
      const done = await rekeyChat(chat, contentKey);
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
  await rekeyProjects(contentKey);
  await rekeyUserMemories(contentKey);
}

/** One credential table: every row not yet under its owner's key, re-sealed. */
async function rekeyCredentials(
  table: LegacyEnvelopeCredentialTable,
  legacyKey: Buffer
): Promise<void> {
  const store = getDataStore().legacyEnvelopes;
  const rows = await store.credentials(table, USER_SEALED);
  let moved = 0;
  for (const row of rows) {
    const opened = decrypt(row.encryptedCredentials, legacyKey);
    if (!opened.ok) {
      console.warn(
        `  ${table}: a row for ${row.subject} did not open under the legacy key; skipped`
      );
      continue;
    }
    const sealed = await legacySealForSubject(row.subject, opened.val);
    if (!sealed.ok) {
      console.warn(`  ${table}: ${row.subject} could not be sealed (${sealed.err.type}); skipped`);
      continue;
    }
    await store.reseal({
      table,
      subject: row.subject,
      stored: row.encryptedCredentials,
      next: sealed.val,
    });
    moved += 1;
  }
  console.log(`${table}: ${moved} of ${rows.length} row(s) moved under their owner's key.`);
}

async function rekeyProviderGrants(legacyKey: Buffer): Promise<void> {
  const store = getDataStore().legacyEnvelopes;
  const rows = await store.providerGrants(USER_SEALED);
  let moved = 0;
  for (const row of rows) {
    if (!row.subject) continue;
    const next: { encryptedAccessToken?: string; encryptedRefreshToken?: string } = {};
    let broken = false;
    for (const column of ['encryptedAccessToken', 'encryptedRefreshToken'] as const) {
      const stored = row[column];
      if (isUserSealed(stored)) continue;
      const opened = decrypt(stored, legacyKey);
      if (!opened.ok) {
        broken = true;
        break;
      }
      const sealed = await legacySealForSubject(row.subject, opened.val);
      if (!sealed.ok) {
        broken = true;
        break;
      }
      next[column] = sealed.val;
    }
    if (broken) {
      console.warn(
        `  provider_grants: ${row.provider}/${row.accountId} did not open or seal; skipped`
      );
      continue;
    }
    await store.reseal({
      table: 'provider_grants',
      provider: row.provider,
      accountId: row.accountId,
      ...next,
    });
    moved += 1;
  }
  console.log(`provider_grants: ${moved} of ${rows.length} row(s) moved under their owner's key.`);
}

async function rekeyConnectors(): Promise<void> {
  const legacy = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!legacy.ok) fail('TOKEN_ENCRYPTION_KEY (the legacy credential key) is not set or malformed.');
  await rekeyProviderGrants(legacy.val);
  await rekeyCredentials('mirth_instance_connections', legacy.val);
  await rekeyCredentials('admanager_instance_connections', legacy.val);
  await rekeyCredentials('file_share_connections', legacy.val);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const all = args.has('--all');
  const connectors = all || args.has('--connectors');
  const chats = all || !args.has('--connectors');

  if (!process.env.DATABASE_URL) fail('Database unavailable — set DATABASE_URL.');

  if (chats) await rekeyChats();
  if (connectors) await rekeyConnectors();
  await closeDataStore();
}

void main();
