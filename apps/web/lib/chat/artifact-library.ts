/**
 * A person's artifacts as a library (docs/artifacts-design.md): the files
 * they own and the ones shared with them, where each is used, and the
 * acts on one that go beyond a chat's attach-and-send — attach it to a
 * project, share it, hand it over, copy it, delete it with its impact
 * known. attachments.ts holds the rows; artifact-access.ts says who may;
 * this is what a route does once they may.
 *
 * Keys follow the rules in artifact-access.ts: an artifact with a key of
 * its own is wrapped under every project that holds it and to every
 * person it is shared with; one still sealed under the chat or project
 * it was uploaded to is RE-SEALED under a key of its own the first time
 * it is shared or attached anywhere else (`promoteKey`), so a chat's
 * upload never has to leave the chat's key until it does.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { resolveTenantBlobStore } from '@renkei/blob-store';
import { randomUUID } from 'node:crypto';
import { isUuid } from '@/lib/uuid';
import { logger } from '@/lib/logger';
import {
  grantResourceAccess,
  listGrantedResources,
  listResourceGrants,
  resolveResourceAccess,
  revokeResourceGrant,
  type GrantView,
} from './access';
import {
  addProjectReference,
  cleanFilename,
  createAttachment,
  deleteAttachment,
  getAttachment,
  getAttachmentText,
  isOcrCandidate,
  listReferencesOf,
  readAttachmentBytes,
  removeProjectReference,
  setReferenceMode,
  type AttachmentError,
  type AttachmentRow,
  type ReferenceMode,
} from './attachments';
import { ocrRunFor, ocrSamples, type OcrRun } from './artifact-ocr';
import { mayUse, resolveArtifactAccess, type ArtifactAccess } from './artifact-access';
import {
  cipherAsOwner,
  createKey,
  deleteKey,
  revokeKey,
  shareKey,
  wrapKeyUnder,
} from './chat-keys';
import {
  openText,
  resourceCipher,
  sealBytes,
  sealText,
  type ContentCipher,
} from './content-crypto';
import type { OutboundRedactor } from './outbound-redaction';
import { notifyArtifactEvent } from './artifact-notifications';

/** Why an act on an artifact was refused. */
export type ArtifactActError =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONTENT_KEY'
  | 'UNCONFIGURED'
  | 'STORE'
  | 'SELF'
  | 'BUDGET'
  | 'INVALID';

/** How large "always in context" may grow per project, in tokens (chars / 4). */
export const ALWAYS_BUDGET_TOKENS = 24_000;
export const tokensOf = (chars: number): number => Math.ceil(chars / 4);

/**
 * A new artifact under a key of its own, owned by `ownerSubject`: a
 * library upload, a project upload, or a chat upload the person asked to
 * keep. The key is minted first so the text seals under it; a row that
 * then fails to insert leaves a key the sweep prunes.
 */
export async function createOwnedArtifact(
  db: Kysely<DB>,
  input: {
    ownerSubject: string;
    chatId?: string | null;
    messageId?: string | null;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    maxBytes: number;
    redactor: OutboundRedactor | null;
    origin?: 'upload' | 'model';
  }
): Promise<Result<AttachmentRow, AttachmentError>> {
  const id = randomUUID();
  const key = await createKey(db, 'artifact', { id, ownerSubject: input.ownerSubject });
  if (!key) return err('CONTENT_KEY' as const);
  const created = await createAttachment(db, {
    id,
    ownerSubject: input.ownerSubject,
    chatId: input.chatId ?? null,
    messageId: input.messageId ?? null,
    filename: input.filename,
    contentType: input.contentType,
    bytes: input.bytes,
    maxBytes: input.maxBytes,
    redactor: input.redactor,
    cipher: resourceCipher(key),
    key: { kind: 'artifact' },
    origin: input.origin ?? 'upload',
  });
  if (!created.ok) {
    await deleteKey(db, 'artifact', id);
    return created;
  }
  if (input.chatId) {
    // Readers of the chat open it through the chat's key, as they do the chat.
    await wrapKeyUnder(
      db,
      'artifact',
      { id, ownerSubject: input.ownerSubject },
      { kind: 'chat', resourceId: input.chatId }
    );
  }
  return created;
}

/**
 * Re-seals a row still under its chat's or project's key under a key of
 * its own, wrapped under the chat it lives in and every project that
 * holds it. Needs the owner's key (minting is the owner's) and a cipher
 * that opens the text and the bytes as they are — the caller's access.
 * The bytes go first: a row that says `artifact` must find its file under
 * the artifact's key.
 */
export async function promoteKey(
  db: Kysely<DB>,
  access: ArtifactAccess
): Promise<Result<AttachmentRow, 'CONTENT_KEY'>> {
  const row = access.row;
  if (row.keyKind === 'artifact') return ok(row);
  const stored = await db
    .selectFrom('artifacts')
    .select('extracted_text')
    .where('id', '=', row.id)
    .executeTakeFirst();
  let text: string | null = null;
  if (stored?.extracted_text) {
    if (access.cipher.unavailable) return err('CONTENT_KEY' as const);
    text = openText(stored.extracted_text, access.cipher);
    if (text.startsWith('[content unavailable')) return err('CONTENT_KEY' as const);
  }
  const own = await cipherAsOwner(db, 'artifact', { id: row.id, ownerSubject: row.ownerSubject });
  if (own.unavailable) return err('CONTENT_KEY' as const);
  let sealed: string | null = null;
  if (text !== null) {
    const result = sealText(text, own);
    if (!result.ok) return err('CONTENT_KEY' as const);
    sealed = result.val;
  }
  const bytes = await readAttachmentBytes(row, access.cipher);
  if (bytes.ok) {
    const store = await resolveTenantBlobStore();
    const resealed = sealBytes(bytes.val, own);
    if (!store.ok || !resealed.ok) return err('CONTENT_KEY' as const);
    const put = await store.val.putObject(row.blobKey, resealed.val, 'application/octet-stream');
    if (!put.ok) return err('CONTENT_KEY' as const);
  } else if (bytes.err.type === 'CONTENT_KEY' || bytes.err.type === 'STORE') {
    // No bytes at all (no store, or none kept for this row) is nothing to
    // move; bytes that will not open or cannot be read must not be left
    // behind under a key the row no longer names.
    return err('CONTENT_KEY' as const);
  }
  await db
    .updateTable('artifacts')
    .set({ key_kind: 'artifact', key_ref: null, extracted_text: sealed, updated_at: new Date() })
    .where('id', '=', row.id)
    .execute();
  const resource = { id: row.id, ownerSubject: row.ownerSubject };
  if (row.chatId) {
    await wrapKeyUnder(db, 'artifact', resource, { kind: 'chat', resourceId: row.chatId });
  }
  for (const reference of await listReferencesOf(db, row.id)) {
    await wrapKeyUnder(db, 'artifact', resource, {
      kind: 'chat_project',
      resourceId: reference.projectId,
    });
  }
  const promoted = await getAttachment(db, row.id);
  return promoted ? ok(promoted) : err('CONTENT_KEY' as const);
}

/** Tokens the project's "always" artifacts already take, with `except` left out. */
export async function alwaysTokensOf(
  db: Kysely<DB>,
  projectId: string,
  except: string | null = null
): Promise<number> {
  const rows = await db
    .selectFrom('artifact_references as r')
    .innerJoin('artifacts as a', 'a.id', 'r.artifact_id')
    .select((eb) =>
      eb.fn.coalesce(eb.fn('length', ['a.extracted_text']), sql<number>`0`).as('chars')
    )
    .where('r.project_id', '=', projectId)
    .where('r.mode', '=', 'always')
    .where('a.id', '!=', except ?? '00000000-0000-0000-0000-000000000000')
    .execute();
  // Sealed text is base64 over the plaintext, so this slightly overstates.
  return rows.reduce((sum, row) => sum + tokensOf(Number(row.chars)), 0);
}

/**
 * Attaches an artifact the actor may USE (owns, or was shared) to a
 * project the actor may edit. Legacy keys are promoted first; the
 * artifact's key is then wrapped under the project's so every member
 * opens it. `always` is refused past the project's budget.
 */
export async function attachToProject(
  db: Kysely<DB>,
  input: {
    actorSubject: string;
    artifactId: string;
    projectId: string;
    mode: ReferenceMode;
  }
): Promise<Result<{ referenceId: string; mode: ReferenceMode }, ArtifactActError>> {
  const access = await resolveArtifactAccess(db, input.actorSubject, input.artifactId);
  if (!access) return err('NOT_FOUND' as const);
  const project = await resolveResourceAccess(
    db,
    input.actorSubject,
    'chat_project',
    input.projectId
  );
  if (!project) return err('NOT_FOUND' as const);
  if (project.role === 'viewer') return err('FORBIDDEN' as const);
  // A member may re-attach a project's own artifact (say, to another of
  // the same owner's projects) only when they may use it.
  if (!mayUse(access) && access.projectId !== input.projectId) return err('FORBIDDEN' as const);
  if (input.mode === 'always') {
    const budget = await alwaysBudgetCheck(db, access.row, input.projectId);
    if (!budget.ok) return budget;
  }
  const promoted = await promoteKey(db, access);
  if (!promoted.ok) return err('CONTENT_KEY' as const);
  const reference = await addProjectReference(db, {
    artifactId: input.artifactId,
    projectId: input.projectId,
    mode: input.mode,
    addedBy: input.actorSubject,
  });
  await wrapKeyUnder(
    db,
    'artifact',
    { id: access.row.id, ownerSubject: access.row.ownerSubject },
    { kind: 'chat_project', resourceId: input.projectId },
    input.actorSubject
  );
  return ok({ referenceId: reference.referenceId, mode: input.mode });
}

async function alwaysBudgetCheck(
  db: Kysely<DB>,
  row: AttachmentRow,
  projectId: string
): Promise<Result<void, ArtifactActError>> {
  if (row.extractStatus !== 'done') return err('INVALID' as const);
  const stored = await db
    .selectFrom('artifacts')
    .select((eb) => eb.fn.coalesce(eb.fn('length', ['extracted_text']), sql<number>`0`).as('chars'))
    .where('id', '=', row.id)
    .executeTakeFirst();
  const used = await alwaysTokensOf(db, projectId, row.id);
  if (used + tokensOf(Number(stored?.chars ?? 0)) > ALWAYS_BUDGET_TOKENS)
    return err('BUDGET' as const);
  return ok();
}

/** Project owner or editor, or the artifact's owner: sets how the project's chats use it. */
export async function setProjectArtifactMode(
  db: Kysely<DB>,
  input: { actorSubject: string; artifactId: string; projectId: string; mode: ReferenceMode }
): Promise<Result<void, ArtifactActError>> {
  const allowed = await mayManageInProject(
    db,
    input.actorSubject,
    input.artifactId,
    input.projectId
  );
  if (!allowed.ok) return allowed;
  if (input.mode === 'always') {
    const budget = await alwaysBudgetCheck(db, allowed.val, input.projectId);
    if (!budget.ok) return budget;
  }
  const changed = await setReferenceMode(db, input);
  return changed ? ok() : err('NOT_FOUND' as const);
}

/** Project owner or editor, or the artifact's owner: the project lets go of it; the file stays. */
export async function detachFromProject(
  db: Kysely<DB>,
  input: { actorSubject: string; artifactId: string; projectId: string }
): Promise<Result<void, ArtifactActError>> {
  const allowed = await mayManageInProject(
    db,
    input.actorSubject,
    input.artifactId,
    input.projectId
  );
  if (!allowed.ok) return allowed;
  const removed = await removeProjectReference(db, input);
  return removed ? ok() : err('NOT_FOUND' as const);
}

async function mayManageInProject(
  db: Kysely<DB>,
  actorSubject: string,
  artifactId: string,
  projectId: string
): Promise<Result<AttachmentRow, ArtifactActError>> {
  const row = await getAttachment(db, artifactId);
  if (!row) return err('NOT_FOUND' as const);
  const project = await resolveResourceAccess(db, actorSubject, 'chat_project', projectId);
  if (!project) return err('NOT_FOUND' as const);
  if (project.role === 'viewer' && row.ownerSubject !== actorSubject) {
    return err('FORBIDDEN' as const);
  }
  return ok(row);
}

/** Owner shares with a person: they may use it, never change it. */
export async function shareArtifact(
  db: Kysely<DB>,
  input: {
    ownerSubject: string;
    artifactId: string;
    granteeSubject: string;
    expiresAt: Date | null;
  }
): Promise<Result<void, ArtifactActError>> {
  const access = await resolveArtifactAccess(db, input.ownerSubject, input.artifactId);
  if (!access || access.role !== 'owner') return err('NOT_FOUND' as const);
  if (input.granteeSubject === input.ownerSubject) return err('SELF' as const);
  const promoted = await promoteKey(db, access);
  if (!promoted.ok) return err('CONTENT_KEY' as const);
  const outcome = await grantResourceAccess(db, input.ownerSubject, 'artifact', input.artifactId, {
    granteeSubject: input.granteeSubject,
    role: 'viewer',
    expiresAt: input.expiresAt,
  });
  if (outcome === 'SELF') return err('SELF' as const);
  if (outcome !== 'OK') return err('NOT_FOUND' as const);
  await shareKey(
    db,
    'artifact',
    { id: input.artifactId, ownerSubject: input.ownerSubject },
    input.granteeSubject
  );
  notifyArtifactEvent({
    kind: 'artifact_shared',
    recipientSubject: input.granteeSubject,
    actorSubject: input.ownerSubject,
    artifactId: input.artifactId,
    filename: access.row.filename,
  });
  return ok();
}

export async function listArtifactGrants(
  db: Kysely<DB>,
  ownerSubject: string,
  artifactId: string
): Promise<GrantView[]> {
  return listResourceGrants(db, ownerSubject, 'artifact', artifactId);
}

/** Owner takes a share back. */
export async function revokeArtifactShare(
  db: Kysely<DB>,
  input: { ownerSubject: string; artifactId: string; grantId: string }
): Promise<boolean> {
  const revoked = await revokeResourceGrant(
    db,
    input.ownerSubject,
    'artifact',
    input.artifactId,
    input.grantId
  );
  if (!revoked) return false;
  await revokeKey(db, 'artifact', input.artifactId, revoked);
  return true;
}

/** A person it was shared with takes it off their own list; the owner's file is untouched. */
export async function leaveArtifact(
  db: Kysely<DB>,
  input: { subject: string; artifactId: string }
): Promise<boolean> {
  if (!isUuid(input.artifactId)) return false;
  const deleted = await db
    .deleteFrom('resource_access_grants')
    .where('resource_kind', '=', 'artifact')
    .where('resource_id', '=', input.artifactId)
    .where('grantee_subject', '=', input.subject)
    .executeTakeFirst();
  if (Number(deleted.numDeletedRows) === 0) return false;
  await revokeKey(db, 'artifact', input.artifactId, input.subject);
  return true;
}

export interface ArtifactImpact {
  projects: { id: string; name: string; kind: string; members: number; mode: ReferenceMode }[];
  sharedWith: { subject: string; name: string | null; email: string | null }[];
  chat: { id: string; title: string | null } | null;
}

/** What deleting (or handing over) an artifact touches: who reads it through what. */
export async function artifactImpact(db: Kysely<DB>, row: AttachmentRow): Promise<ArtifactImpact> {
  const references = await listReferencesOf(db, row.id);
  const projects =
    references.length > 0
      ? await db
          .selectFrom('chat_projects as p')
          .leftJoin('resource_access_grants as g', (join) =>
            join
              .onRef('g.resource_id', '=', 'p.id')
              .on('g.resource_kind', '=', 'chat_project')
              .on((eb) =>
                eb.or([eb('g.expires_at', 'is', null), eb('g.expires_at', '>', new Date())])
              )
          )
          .select((eb) => ['p.id', 'p.name', 'p.kind', eb.fn.count<number>('g.id').as('grants')])
          .where(
            'p.id',
            'in',
            references.map((reference) => reference.projectId)
          )
          .groupBy(['p.id', 'p.name', 'p.kind'])
          .execute()
      : [];
  const modes = new Map(references.map((reference) => [reference.projectId, reference.mode]));
  const grants = await listResourceGrants(db, row.ownerSubject, 'artifact', row.id);
  const chat = row.chatId
    ? await db
        .selectFrom('chats')
        .select(['id', 'title'])
        .where('id', '=', row.chatId)
        .executeTakeFirst()
    : null;
  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      kind: project.kind,
      // The owner and the people granted access.
      members: Number(project.grants) + 1,
      mode: modes.get(project.id) ?? 'on_demand',
    })),
    sharedWith: grants
      .filter((grant) => !grant.expired)
      .map((grant) => ({
        subject: grant.granteeSubject,
        name: grant.granteeName,
        email: grant.granteeEmail,
      })),
    chat: chat ? { id: chat.id, title: chat.title } : null,
  };
}

/** Owner deletes it for everyone: row, bytes, key, shares. References cascade. */
export async function deleteArtifact(db: Kysely<DB>, row: AttachmentRow): Promise<boolean> {
  const deleted = await deleteAttachment(db, row);
  if (!deleted) return false;
  await db
    .deleteFrom('resource_access_grants')
    .where('resource_kind', '=', 'artifact')
    .where('resource_id', '=', row.id)
    .execute();
  if (row.keyKind === 'artifact') await deleteKey(db, 'artifact', row.id);
  return true;
}

/**
 * Owner hands it over: the new owner keeps the file, every project
 * attachment and every share; the old owner's own access ends (they can
 * be shared it back). The new owner opens it through the share's sealed
 * box, which their next signed-in read turns into a wrapping of their own.
 */
export async function transferArtifact(
  db: Kysely<DB>,
  input: { ownerSubject: string; artifactId: string; newOwnerSubject: string }
): Promise<Result<void, ArtifactActError>> {
  const access = await resolveArtifactAccess(db, input.ownerSubject, input.artifactId);
  if (!access || access.role !== 'owner') return err('NOT_FOUND' as const);
  if (input.newOwnerSubject === input.ownerSubject) return err('SELF' as const);
  const promoted = await promoteKey(db, access);
  if (!promoted.ok) return err('CONTENT_KEY' as const);
  const resource = { id: input.artifactId, ownerSubject: input.ownerSubject };
  const shared = await shareKey(db, 'artifact', resource, input.newOwnerSubject);
  if (!shared) return err('CONTENT_KEY' as const);
  await db
    .updateTable('artifacts')
    .set({ owner_subject: input.newOwnerSubject, updated_at: new Date() })
    .where('id', '=', input.artifactId)
    .execute();
  // Owners need no grant; the old owner keeps none of their wrappings.
  await db
    .deleteFrom('resource_access_grants')
    .where('resource_kind', '=', 'artifact')
    .where('resource_id', '=', input.artifactId)
    .where('grantee_subject', '=', input.newOwnerSubject)
    .execute();
  await db
    .updateTable('resource_access_grants')
    .set({ owner_subject: input.newOwnerSubject })
    .where('resource_kind', '=', 'artifact')
    .where('resource_id', '=', input.artifactId)
    .execute();
  await revokeKey(db, 'artifact', input.artifactId, input.ownerSubject);
  notifyArtifactEvent({
    kind: 'artifact_transferred',
    recipientSubject: input.newOwnerSubject,
    actorSubject: input.ownerSubject,
    artifactId: input.artifactId,
    filename: access.row.filename,
  });
  return ok();
}

/**
 * A person it is shared with (or a member reading it) makes a copy they
 * own: the same bytes under a new row and key of their own, optionally
 * attached to one of their projects in place of the original. The
 * original's owner is told.
 */
export async function copyArtifact(
  db: Kysely<DB>,
  input: {
    actorSubject: string;
    artifactId: string;
    filename: string | null;
    attachProjectId: string | null;
    mode: ReferenceMode;
    maxBytes: number;
    redactor: OutboundRedactor | null;
  }
): Promise<Result<AttachmentRow, ArtifactActError>> {
  const access = await resolveArtifactAccess(db, input.actorSubject, input.artifactId);
  if (!access) return err('NOT_FOUND' as const);
  if (access.role === 'owner') return err('SELF' as const);
  const object = await readAttachmentBytes(access.row, access.cipher);
  if (!object.ok) {
    return err(
      object.err.type === 'UNCONFIGURED'
        ? ('UNCONFIGURED' as const)
        : object.err.type === 'CONTENT_KEY'
          ? ('CONTENT_KEY' as const)
          : ('STORE' as const)
    );
  }
  const created = await createOwnedArtifact(db, {
    ownerSubject: input.actorSubject,
    filename: input.filename ? cleanFilename(input.filename) : copyName(access.row.filename),
    contentType: access.row.contentType,
    bytes: object.val,
    maxBytes: input.maxBytes,
    redactor: input.redactor,
    origin: 'upload',
  });
  if (!created.ok) {
    return err(
      created.err.type === 'CONTENT_KEY'
        ? ('CONTENT_KEY' as const)
        : created.err.type === 'UNCONFIGURED'
          ? ('UNCONFIGURED' as const)
          : ('STORE' as const)
    );
  }
  // Extraction ran again on the bytes; when the original had OCR'd text
  // the copy would otherwise lose it, so carry the text across.
  if (created.val.extractStatus !== 'done' && access.row.extractStatus === 'done') {
    const text = await getAttachmentText(db, access.row.id, access.cipher);
    if (text && !text.startsWith('[content unavailable')) {
      const own = await cipherAsOwner(db, 'artifact', {
        id: created.val.id,
        ownerSubject: input.actorSubject,
      });
      const sealed = sealText(text, own);
      if (sealed.ok) {
        await db
          .updateTable('artifacts')
          .set({ extracted_text: sealed.val, extract_status: 'done' })
          .where('id', '=', created.val.id)
          .execute();
      }
    }
  }
  // The same bytes are about the same things: the digest comes across
  // too, in the clear as it was, rather than being asked for again.
  if (access.row.digestStatus === 'done' && access.row.summary !== null) {
    await db
      .updateTable('artifacts')
      .set((eb) => ({
        summary: access.row.summary,
        keywords: access.row.keywords,
        search_vector: eb
          .selectFrom('artifacts')
          .select('search_vector')
          .where('id', '=', access.row.id),
        digest_status: 'done',
      }))
      .where('id', '=', created.val.id)
      .execute();
  }
  if (input.attachProjectId) {
    await attachToProject(db, {
      actorSubject: input.actorSubject,
      artifactId: created.val.id,
      projectId: input.attachProjectId,
      mode: input.mode,
    });
    if (access.projectId === input.attachProjectId || access.role === 'use') {
      // In place of the original where this person may let go of it.
      await detachFromProject(db, {
        actorSubject: input.actorSubject,
        artifactId: access.row.id,
        projectId: input.attachProjectId,
      });
    }
  }
  notifyArtifactEvent({
    kind: 'artifact_copied',
    recipientSubject: access.row.ownerSubject,
    actorSubject: input.actorSubject,
    artifactId: access.row.id,
    filename: access.row.filename,
  });
  return ok(created.val);
}

function copyName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)} (copy)${filename.slice(dot)}` : `${filename} (copy)`;
}

/** Owner renames; the bytes and every reference stay. */
export async function renameArtifact(
  db: Kysely<DB>,
  input: { ownerSubject: string; artifactId: string; filename: string }
): Promise<boolean> {
  if (!isUuid(input.artifactId)) return false;
  const result = await db
    .updateTable('artifacts')
    .set({ filename: cleanFilename(input.filename), updated_at: new Date() })
    .where('id', '=', input.artifactId)
    .where('owner_subject', '=', input.ownerSubject)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export interface LibraryItem {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  extractStatus: string;
  origin: string;
  ownerSubject: string;
  ownerName: string | null;
  /** How the viewer holds it: theirs, shared with them, or read through a project or chat. */
  via: 'owner' | 'grant' | 'project' | 'chat';
  /** The chat it came from, when that chat still exists. */
  chat: { id: string; title: string | null; projectId: string | null } | null;
  projects: { id: string; name: string; kind: string; mode: ReferenceMode }[];
  /** People it is shared with — the owner's view only. */
  sharedWith: number;
  /** The digest for the search index (artifact-digest.ts), when the model has written it. */
  summary: string | null;
  keywords: string[];
  digestStatus: string;
  /** Whether OCR takes this file (a PDF or an image), so the page can offer it. */
  ocrSupported: boolean;
  /** The OCR run in flight, with how long it has taken and how long it has left. */
  ocr: OcrRun | null;
  /** Pages the last OCR read, once one has finished. */
  ocrPages: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Everything in this person's library: what they own, then what was shared with them. */
export async function listLibrary(db: Kysely<DB>, viewerSubject: string): Promise<LibraryItem[]> {
  const owned = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('owner_subject', '=', viewerSubject)
    .orderBy('created_at', 'desc')
    .execute();
  const granted = await listGrantedResources(db, viewerSubject, 'artifact');
  const sharedRows =
    granted.length > 0
      ? await db
          .selectFrom('artifacts')
          .selectAll()
          .where(
            'id',
            'in',
            granted.map((grant) => grant.resourceId)
          )
          .orderBy('created_at', 'desc')
          .execute()
      : [];
  return libraryItems(db, viewerSubject, [...owned, ...sharedRows], () => 'grant');
}

/** One artifact as the viewer holds it (artifact-access.ts says how). */
export async function libraryItemFor(
  db: Kysely<DB>,
  viewerSubject: string,
  access: ArtifactAccess
): Promise<LibraryItem | null> {
  const raw = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('id', '=', access.row.id)
    .executeTakeFirst();
  if (!raw) return null;
  const items = await libraryItems(db, viewerSubject, [raw], () =>
    access.via === 'owner' ? 'grant' : access.via
  );
  return items[0] ?? null;
}

/** The rows as library items: where each is used, who shares it, and who owns it, looked up once for the lot. */
export async function libraryItems(
  db: Kysely<DB>,
  viewerSubject: string,
  rows: {
    id: string;
    owner_subject: string;
    chat_id: string | null;
    filename: string;
    content_type: string;
    size_bytes: string | number | bigint;
    extract_status: string;
    origin: string;
    summary: string | null;
    keywords: string[];
    digest_status: string;
    ocr_started_at: Date | null;
    ocr_pages: number | null;
    created_at: Date;
    updated_at: Date;
  }[],
  viaOf: (row: { id: string }) => 'grant' | 'project' | 'chat'
): Promise<LibraryItem[]> {
  if (rows.length === 0) return [];
  // The estimate's samples are read only when a run is in flight to need one.
  const samples = rows.some((row) => row.ocr_started_at) ? await ocrSamples(db) : [];
  const now = Date.now();
  const sharedRows = rows.filter((row) => row.owner_subject !== viewerSubject);
  const ids = rows.map((row) => row.id);
  const [references, shares, chats, identities] = await Promise.all([
    db
      .selectFrom('artifact_references as r')
      .innerJoin('chat_projects as p', 'p.id', 'r.project_id')
      .select(['r.artifact_id', 'r.mode', 'p.id', 'p.name', 'p.kind'])
      .where('r.artifact_id', 'in', ids)
      .orderBy('r.created_at', 'asc')
      .execute(),
    db
      .selectFrom('resource_access_grants')
      .select((eb) => ['resource_id', eb.fn.count<number>('id').as('count')])
      .where('resource_kind', '=', 'artifact')
      .where('resource_id', 'in', ids)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())]))
      .groupBy('resource_id')
      .execute(),
    (() => {
      const chatIds = [...new Set(rows.flatMap((row) => (row.chat_id ? [row.chat_id] : [])))];
      return chatIds.length > 0
        ? db
            .selectFrom('chats')
            .select(['id', 'title', 'project_id'])
            .where('id', 'in', chatIds)
            .execute()
        : Promise.resolve([]);
    })(),
    (() => {
      const owners = [...new Set(sharedRows.map((row) => row.owner_subject))];
      return owners.length > 0
        ? db
            .selectFrom('identities')
            .select(['subject', 'display_name', 'email'])
            .where('subject', 'in', owners)
            .execute()
        : Promise.resolve([]);
    })(),
  ]);
  const byArtifact = new Map<string, LibraryItem['projects']>();
  for (const reference of references) {
    const list = byArtifact.get(reference.artifact_id) ?? [];
    list.push({
      id: reference.id,
      name: reference.name,
      kind: reference.kind,
      mode: reference.mode === 'always' ? 'always' : 'on_demand',
    });
    byArtifact.set(reference.artifact_id, list);
  }
  const shareCounts = new Map(shares.map((share) => [share.resource_id, Number(share.count)]));
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const names = new Map(identities.map((row) => [row.subject, row.display_name ?? row.email]));
  return rows.map((row) => {
    const chat = row.chat_id ? chatById.get(row.chat_id) : null;
    return {
      id: row.id,
      filename: row.filename,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      extractStatus: row.extract_status,
      origin: row.origin,
      ownerSubject: row.owner_subject,
      ownerName:
        row.owner_subject === viewerSubject ? null : (names.get(row.owner_subject) ?? null),
      via: row.owner_subject === viewerSubject ? 'owner' : viaOf(row),
      chat: chat ? { id: chat.id, title: chat.title, projectId: chat.project_id } : null,
      projects: byArtifact.get(row.id) ?? [],
      sharedWith: row.owner_subject === viewerSubject ? (shareCounts.get(row.id) ?? 0) : 0,
      summary: row.summary,
      keywords: row.keywords,
      digestStatus: row.digest_status,
      ocrSupported: isOcrCandidate(row.filename, row.content_type),
      ocr: ocrRunFor(row.ocr_started_at, Number(row.size_bytes), samples, now),
      ocrPages: row.ocr_pages,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

/**
 * The owner replaces the bytes, keeping the row, every reference and
 * every share: the text is extracted again and sealed under the same key.
 */
export async function replaceArtifactBytes(
  db: Kysely<DB>,
  input: {
    access: ArtifactAccess;
    bytes: Uint8Array;
    contentType: string;
    filename: string | null;
    maxBytes: number;
    redactor: OutboundRedactor | null;
  }
): Promise<Result<AttachmentRow, ArtifactActError>> {
  const { row } = input.access;
  if (input.access.role !== 'owner') return err('FORBIDDEN' as const);
  // Re-extraction is createAttachment's; a replacement is a new row's
  // worth of work under the old row's identity, so do it as a swap: the
  // new row takes the old id after the old row's bytes are dropped.
  const promoted = await promoteKey(db, input.access);
  if (!promoted.ok) return err('CONTENT_KEY' as const);
  const cipher: ContentCipher = await cipherAsOwner(db, 'artifact', {
    id: row.id,
    ownerSubject: row.ownerSubject,
  });
  if (cipher.unavailable) return err('CONTENT_KEY' as const);
  const store = await resolveTenantBlobStore();
  if (!store.ok) return err('UNCONFIGURED' as const);
  const temp = await createAttachment(db, {
    ownerSubject: row.ownerSubject,
    chatId: null,
    filename: input.filename ?? row.filename,
    contentType: input.contentType,
    bytes: input.bytes,
    maxBytes: input.maxBytes,
    redactor: input.redactor,
    cipher,
    key: { kind: 'artifact' },
  });
  if (!temp.ok) {
    return err(temp.err.type === 'TOO_LARGE' ? ('INVALID' as const) : ('STORE' as const));
  }
  const text = await db
    .selectFrom('artifacts')
    .select('extracted_text')
    .where('id', '=', temp.val.id)
    .executeTakeFirst();
  await db
    .updateTable('artifacts')
    .set({
      blob_key: temp.val.blobKey,
      filename: temp.val.filename,
      content_type: temp.val.contentType,
      size_bytes: temp.val.sizeBytes,
      extracted_text: text?.extracted_text ?? null,
      extract_status: temp.val.extractStatus,
      // The old digest described the old bytes: start over.
      summary: null,
      keywords: [],
      search_vector: null,
      digest_status: temp.val.digestStatus,
      updated_at: new Date(),
    })
    .where('id', '=', row.id)
    .execute();
  await db.deleteFrom('artifacts').where('id', '=', temp.val.id).execute();
  const dropped = await store.val.deleteObject(row.blobKey);
  if (!dropped.ok) {
    logger.warn('replaced artifact bytes not deleted: {key}', {
      component: 'chat/artifact-library',
      key: row.blobKey,
    });
  }
  const updated = await getAttachment(db, row.id);
  return updated ? ok(updated) : err('NOT_FOUND' as const);
}
