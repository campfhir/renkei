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

import { getDataStore, type ArtifactRecord } from '@renkei/db';
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
export async function createOwnedArtifact(input: {
  ownerSubject: string;
  chatId?: string | null;
  messageId?: string | null;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  maxBytes: number;
  redactor: OutboundRedactor | null;
  origin?: 'upload' | 'model';
}): Promise<Result<AttachmentRow, AttachmentError>> {
  const id = randomUUID();
  const key = await createKey('artifact', { id, ownerSubject: input.ownerSubject });
  if (!key) return err('CONTENT_KEY' as const);
  const created = await createAttachment({
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
    await deleteKey('artifact', id);
    return created;
  }
  if (input.chatId) {
    // Readers of the chat open it through the chat's key, as they do the chat.
    await wrapKeyUnder(
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
  access: ArtifactAccess
): Promise<Result<AttachmentRow, 'CONTENT_KEY'>> {
  const row = access.row;
  if (row.keyKind === 'artifact') return ok(row);
  const stored = await getDataStore().artifacts.getText(row.id);
  let text: string | null = null;
  if (stored) {
    if (access.cipher.unavailable) return err('CONTENT_KEY' as const);
    text = openText(stored, access.cipher);
    if (text.startsWith('[content unavailable')) return err('CONTENT_KEY' as const);
  }
  const own = await cipherAsOwner('artifact', { id: row.id, ownerSubject: row.ownerSubject });
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
  await getDataStore().artifacts.update(row.id, {
    keyKind: 'artifact',
    keyRef: null,
    extractedText: sealed,
  });
  const resource = { id: row.id, ownerSubject: row.ownerSubject };
  if (row.chatId) {
    await wrapKeyUnder('artifact', resource, { kind: 'chat', resourceId: row.chatId });
  }
  for (const reference of await listReferencesOf(row.id)) {
    await wrapKeyUnder('artifact', resource, {
      kind: 'chat_project',
      resourceId: reference.projectId,
    });
  }
  const promoted = await getAttachment(row.id);
  return promoted ? ok(promoted) : err('CONTENT_KEY' as const);
}

/** Tokens the project's "always" artifacts already take, with `except` left out. */
export async function alwaysTokensOf(
  projectId: string,
  except: string | null = null
): Promise<number> {
  const rows = await getDataStore().artifacts.alwaysTextLengths(
    projectId,
    except && isUuid(except) ? except : null
  );
  // Sealed text is base64 over the plaintext, so this slightly overstates.
  return rows.reduce((sum, row) => sum + tokensOf(row.chars), 0);
}

/**
 * Attaches an artifact the actor may USE (owns, or was shared) to a
 * project the actor may edit. Legacy keys are promoted first; the
 * artifact's key is then wrapped under the project's so every member
 * opens it. `always` is refused past the project's budget.
 */
export async function attachToProject(input: {
  actorSubject: string;
  artifactId: string;
  projectId: string;
  mode: ReferenceMode;
}): Promise<Result<{ referenceId: string; mode: ReferenceMode }, ArtifactActError>> {
  const access = await resolveArtifactAccess(input.actorSubject, input.artifactId);
  if (!access) return err('NOT_FOUND' as const);
  const project = await resolveResourceAccess(input.actorSubject, 'chat_project', input.projectId);
  if (!project) return err('NOT_FOUND' as const);
  if (project.role === 'viewer') return err('FORBIDDEN' as const);
  // A member may re-attach a project's own artifact (say, to another of
  // the same owner's projects) only when they may use it.
  if (!mayUse(access) && access.projectId !== input.projectId) return err('FORBIDDEN' as const);
  if (input.mode === 'always') {
    const budget = await alwaysBudgetCheck(access.row, input.projectId);
    if (!budget.ok) return budget;
  }
  const promoted = await promoteKey(access);
  if (!promoted.ok) return err('CONTENT_KEY' as const);
  const reference = await addProjectReference({
    artifactId: input.artifactId,
    projectId: input.projectId,
    mode: input.mode,
    addedBy: input.actorSubject,
  });
  await wrapKeyUnder(
    'artifact',
    { id: access.row.id, ownerSubject: access.row.ownerSubject },
    { kind: 'chat_project', resourceId: input.projectId },
    input.actorSubject
  );
  return ok({ referenceId: reference.referenceId, mode: input.mode });
}

async function alwaysBudgetCheck(
  row: AttachmentRow,
  projectId: string
): Promise<Result<void, ArtifactActError>> {
  if (row.extractStatus !== 'done') return err('INVALID' as const);
  const [stored] = await getDataStore().artifacts.textLengths([row.id]);
  const used = await alwaysTokensOf(projectId, row.id);
  if (used + tokensOf(stored?.chars ?? 0) > ALWAYS_BUDGET_TOKENS) return err('BUDGET' as const);
  return ok();
}

/** Project owner or editor, or the artifact's owner: sets how the project's chats use it. */
export async function setProjectArtifactMode(input: {
  actorSubject: string;
  artifactId: string;
  projectId: string;
  mode: ReferenceMode;
}): Promise<Result<void, ArtifactActError>> {
  const allowed = await mayManageInProject(input.actorSubject, input.artifactId, input.projectId);
  if (!allowed.ok) return allowed;
  if (input.mode === 'always') {
    const budget = await alwaysBudgetCheck(allowed.val, input.projectId);
    if (!budget.ok) return budget;
  }
  const changed = await setReferenceMode({
    artifactId: input.artifactId,
    projectId: input.projectId,
    mode: input.mode,
  });
  return changed ? ok() : err('NOT_FOUND' as const);
}

/** Project owner or editor, or the artifact's owner: the project lets go of it; the file stays. */
export async function detachFromProject(input: {
  actorSubject: string;
  artifactId: string;
  projectId: string;
}): Promise<Result<void, ArtifactActError>> {
  const allowed = await mayManageInProject(input.actorSubject, input.artifactId, input.projectId);
  if (!allowed.ok) return allowed;
  const removed = await removeProjectReference({
    artifactId: input.artifactId,
    projectId: input.projectId,
  });
  return removed ? ok() : err('NOT_FOUND' as const);
}

async function mayManageInProject(
  actorSubject: string,
  artifactId: string,
  projectId: string
): Promise<Result<AttachmentRow, ArtifactActError>> {
  const row = await getAttachment(artifactId);
  if (!row) return err('NOT_FOUND' as const);
  const project = await resolveResourceAccess(actorSubject, 'chat_project', projectId);
  if (!project) return err('NOT_FOUND' as const);
  if (project.role === 'viewer' && row.ownerSubject !== actorSubject) {
    return err('FORBIDDEN' as const);
  }
  return ok(row);
}

/** Owner shares with a person: they may use it, never change it. */
export async function shareArtifact(input: {
  ownerSubject: string;
  artifactId: string;
  granteeSubject: string;
  expiresAt: Date | null;
}): Promise<Result<void, ArtifactActError>> {
  const access = await resolveArtifactAccess(input.ownerSubject, input.artifactId);
  if (!access || access.role !== 'owner') return err('NOT_FOUND' as const);
  if (input.granteeSubject === input.ownerSubject) return err('SELF' as const);
  const promoted = await promoteKey(access);
  if (!promoted.ok) return err('CONTENT_KEY' as const);
  const outcome = await grantResourceAccess(input.ownerSubject, 'artifact', input.artifactId, {
    granteeSubject: input.granteeSubject,
    role: 'viewer',
    expiresAt: input.expiresAt,
  });
  if (outcome === 'SELF') return err('SELF' as const);
  if (outcome !== 'OK') return err('NOT_FOUND' as const);
  await shareKey(
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
  ownerSubject: string,
  artifactId: string
): Promise<GrantView[]> {
  return listResourceGrants(ownerSubject, 'artifact', artifactId);
}

/** Owner takes a share back. */
export async function revokeArtifactShare(input: {
  ownerSubject: string;
  artifactId: string;
  grantId: string;
}): Promise<boolean> {
  const revoked = await revokeResourceGrant(
    input.ownerSubject,
    'artifact',
    input.artifactId,
    input.grantId
  );
  if (!revoked) return false;
  await revokeKey('artifact', input.artifactId, revoked);
  return true;
}

/** A person it was shared with takes it off their own list; the owner's file is untouched. */
export async function leaveArtifact(input: {
  subject: string;
  artifactId: string;
}): Promise<boolean> {
  if (!isUuid(input.artifactId)) return false;
  const deleted = await getDataStore().resourceGrants.removeGrantee(
    'artifact',
    input.artifactId,
    input.subject
  );
  if (deleted === 0) return false;
  await revokeKey('artifact', input.artifactId, input.subject);
  return true;
}

export interface ArtifactImpact {
  projects: { id: string; name: string; kind: string; members: number; mode: ReferenceMode }[];
  sharedWith: { subject: string; name: string | null; email: string | null }[];
  chat: { id: string; title: string | null } | null;
}

/** What deleting (or handing over) an artifact touches: who reads it through what. */
export async function artifactImpact(row: AttachmentRow): Promise<ArtifactImpact> {
  const store = getDataStore();
  const references = await listReferencesOf(row.id);
  const projects =
    references.length > 0
      ? await store.chatProjects.withGrantCounts(references.map((reference) => reference.projectId))
      : [];
  const modes = new Map(references.map((reference) => [reference.projectId, reference.mode]));
  const grants = await listResourceGrants(row.ownerSubject, 'artifact', row.id);
  const chat = row.chatId && isUuid(row.chatId) ? await store.chats.get(row.chatId) : null;
  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      kind: project.kind,
      // The owner and the people granted access.
      members: project.grants + 1,
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
export async function deleteArtifact(row: AttachmentRow): Promise<boolean> {
  const deleted = await deleteAttachment(row);
  if (!deleted) return false;
  await getDataStore().resourceGrants.deleteForResource('artifact', row.id);
  if (row.keyKind === 'artifact') await deleteKey('artifact', row.id);
  return true;
}

/**
 * Owner hands it over: the new owner keeps the file, every project
 * attachment and every share; the old owner's own access ends (they can
 * be shared it back). The new owner opens it through the share's sealed
 * box, which their next signed-in read turns into a wrapping of their own.
 */
export async function transferArtifact(input: {
  ownerSubject: string;
  artifactId: string;
  newOwnerSubject: string;
}): Promise<Result<void, ArtifactActError>> {
  const access = await resolveArtifactAccess(input.ownerSubject, input.artifactId);
  if (!access || access.role !== 'owner') return err('NOT_FOUND' as const);
  if (input.newOwnerSubject === input.ownerSubject) return err('SELF' as const);
  const promoted = await promoteKey(access);
  if (!promoted.ok) return err('CONTENT_KEY' as const);
  const resource = { id: input.artifactId, ownerSubject: input.ownerSubject };
  const shared = await shareKey('artifact', resource, input.newOwnerSubject);
  if (!shared) return err('CONTENT_KEY' as const);
  // Owners need no grant; the old owner keeps none of their wrappings.
  await getDataStore().artifacts.transferOwnership(input.artifactId, input.newOwnerSubject);
  await revokeKey('artifact', input.artifactId, input.ownerSubject);
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
export async function copyArtifact(input: {
  actorSubject: string;
  artifactId: string;
  filename: string | null;
  attachProjectId: string | null;
  mode: ReferenceMode;
  maxBytes: number;
  redactor: OutboundRedactor | null;
}): Promise<Result<AttachmentRow, ArtifactActError>> {
  const access = await resolveArtifactAccess(input.actorSubject, input.artifactId);
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
  const created = await createOwnedArtifact({
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
    const text = await getAttachmentText(access.row.id, access.cipher);
    if (text && !text.startsWith('[content unavailable')) {
      const own = await cipherAsOwner('artifact', {
        id: created.val.id,
        ownerSubject: input.actorSubject,
      });
      const sealed = sealText(text, own);
      if (sealed.ok) {
        await getDataStore().artifacts.update(created.val.id, {
          extractedText: sealed.val,
          extractStatus: 'done',
        });
      }
    }
  }
  // The same bytes are about the same things: the digest comes across
  // too, in the clear as it was, rather than being asked for again.
  if (access.row.digestStatus === 'done' && access.row.summary !== null) {
    await getDataStore().artifacts.copyDigest({
      targetId: created.val.id,
      sourceId: access.row.id,
      summary: access.row.summary,
      keywords: access.row.keywords,
    });
  }
  if (input.attachProjectId) {
    await attachToProject({
      actorSubject: input.actorSubject,
      artifactId: created.val.id,
      projectId: input.attachProjectId,
      mode: input.mode,
    });
    if (access.projectId === input.attachProjectId || access.role === 'use') {
      // In place of the original where this person may let go of it.
      await detachFromProject({
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
export async function renameArtifact(input: {
  ownerSubject: string;
  artifactId: string;
  filename: string;
}): Promise<boolean> {
  if (!isUuid(input.artifactId)) return false;
  return getDataStore().artifacts.rename({
    artifactId: input.artifactId,
    ownerSubject: input.ownerSubject,
    filename: cleanFilename(input.filename),
  });
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
export async function listLibrary(viewerSubject: string): Promise<LibraryItem[]> {
  const store = getDataStore();
  const owned = await store.artifacts.listOwned(viewerSubject);
  const granted = await listGrantedResources(viewerSubject, 'artifact');
  const sharedIds = granted.map((grant) => grant.resourceId).filter(isUuid);
  const sharedRows =
    sharedIds.length > 0
      ? [...(await store.artifacts.getMany(sharedIds))].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1)
        )
      : [];
  return libraryItems(viewerSubject, [...owned, ...sharedRows], () => 'grant');
}

/** One artifact as the viewer holds it (artifact-access.ts says how). */
export async function libraryItemFor(
  viewerSubject: string,
  access: ArtifactAccess
): Promise<LibraryItem | null> {
  const raw = await getDataStore().artifacts.get(access.row.id);
  if (!raw) return null;
  const items = await libraryItems(viewerSubject, [raw], () =>
    access.via === 'owner' ? 'grant' : access.via
  );
  return items[0] ?? null;
}

/** The rows as library items: where each is used, who shares it, and who owns it, looked up once for the lot. */
export async function libraryItems(
  viewerSubject: string,
  rows: ArtifactRecord[],
  viaOf: (row: { id: string }) => 'grant' | 'project' | 'chat'
): Promise<LibraryItem[]> {
  if (rows.length === 0) return [];
  const store = getDataStore();
  // The estimate's samples are read only when a run is in flight to need one.
  const samples = rows.some((row) => row.ocrStartedAt) ? await ocrSamples() : [];
  const now = Date.now();
  const sharedRows = rows.filter((row) => row.ownerSubject !== viewerSubject);
  const ids = rows.map((row) => row.id);
  const chatIds = [...new Set(rows.flatMap((row) => (row.chatId ? [row.chatId] : [])))];
  const owners = [...new Set(sharedRows.map((row) => row.ownerSubject))];
  const [references, shares, chats, identities] = await Promise.all([
    store.artifacts.projectsUsing(ids),
    store.resourceGrants.countActive('artifact', ids),
    chatIds.length > 0 ? store.chats.listByIds(chatIds) : Promise.resolve([]),
    owners.length > 0 ? store.identities.listBySubjects(owners) : Promise.resolve([]),
  ]);
  const byArtifact = new Map<string, LibraryItem['projects']>();
  for (const reference of references) {
    const list = byArtifact.get(reference.artifactId) ?? [];
    list.push({
      id: reference.projectId,
      name: reference.name,
      kind: reference.kind,
      mode: reference.mode === 'always' ? 'always' : 'on_demand',
    });
    byArtifact.set(reference.artifactId, list);
  }
  const shareCounts = new Map(shares.map((share) => [share.resourceId, share.count]));
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const names = new Map(identities.map((row) => [row.subject, row.displayName ?? row.email]));
  return rows.map((row) => {
    const chat = row.chatId ? chatById.get(row.chatId) : null;
    return {
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      extractStatus: row.extractStatus,
      origin: row.origin,
      ownerSubject: row.ownerSubject,
      ownerName: row.ownerSubject === viewerSubject ? null : (names.get(row.ownerSubject) ?? null),
      via: row.ownerSubject === viewerSubject ? 'owner' : viaOf(row),
      chat: chat ? { id: chat.id, title: chat.title, projectId: chat.projectId } : null,
      projects: byArtifact.get(row.id) ?? [],
      sharedWith: row.ownerSubject === viewerSubject ? (shareCounts.get(row.id) ?? 0) : 0,
      summary: row.summary,
      keywords: row.keywords,
      digestStatus: row.digestStatus,
      ocrSupported: isOcrCandidate(row.filename, row.contentType),
      ocr: ocrRunFor(row.ocrStartedAt, row.sizeBytes, samples, now),
      ocrPages: row.ocrPages,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/**
 * The owner replaces the bytes, keeping the row, every reference and
 * every share: the text is extracted again and sealed under the same key.
 */
export async function replaceArtifactBytes(input: {
  access: ArtifactAccess;
  bytes: Uint8Array;
  contentType: string;
  filename: string | null;
  maxBytes: number;
  redactor: OutboundRedactor | null;
}): Promise<Result<AttachmentRow, ArtifactActError>> {
  const { row } = input.access;
  if (input.access.role !== 'owner') return err('FORBIDDEN' as const);
  // Re-extraction is createAttachment's; a replacement is a new row's
  // worth of work under the old row's identity, so do it as a swap: the
  // new row takes the old id after the old row's bytes are dropped.
  const promoted = await promoteKey(input.access);
  if (!promoted.ok) return err('CONTENT_KEY' as const);
  const cipher: ContentCipher = await cipherAsOwner('artifact', {
    id: row.id,
    ownerSubject: row.ownerSubject,
  });
  if (cipher.unavailable) return err('CONTENT_KEY' as const);
  const store = await resolveTenantBlobStore();
  if (!store.ok) return err('UNCONFIGURED' as const);
  const temp = await createAttachment({
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
  // The old digest described the old bytes: it starts over.
  await getDataStore().artifacts.adoptContent(row.id, temp.val.id);
  const dropped = await store.val.deleteObject(row.blobKey);
  if (!dropped.ok) {
    logger.warn('replaced artifact bytes not deleted: {key}', {
      component: 'chat/artifact-library',
      subject: row.ownerSubject,
      artifactId: row.id,
      key: row.blobKey,
    });
  }
  const updated = await getAttachment(row.id);
  return updated ? ok(updated) : err('NOT_FOUND' as const);
}
