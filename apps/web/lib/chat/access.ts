/**
 * Who may see what in the chat, in one place — the agent access-grants
 * pattern (064) generalized over resource_access_grants (092).
 *
 * The rules:
 *   - The owner of a chat, project or library always resolves as owner.
 *   - A named grantee resolves with the grant's role while the grant has
 *     not expired. Chat grants are viewer-only: sharing a chat means
 *     letting someone read and watch it, never continue it.
 *   - "Published to the organization" is gone (docs/delegate-key-design.md,
 *     decision 1): there is no tenant-wide key, so a project or library is
 *     readable by its owner and the people invited, and a row still
 *     flagged `published_to_org` from before grants nobody anything.
 *   - A chat inside a project the viewer can access resolves as viewer
 *     (members chat with the same context and can read each other's
 *     chats), unless the viewer owns it.
 *   - Nobody else resolves: null, which callers surface as 404 — never
 *     403, matching the structural-ownership rule everywhere else.
 *
 * Grant management is owner-only, enforced structurally: every mutation
 * is keyed by the owner's subject.
 */

import { getDataStore } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { getChatRow, type ChatRow } from './store';
import { cipherFor } from './chat-keys';
import type { ContentCipher } from './content-crypto';

export type ResourceKind = 'chat' | 'chat_project' | 'prompt_library' | 'artifact';
export type GrantRole = 'viewer' | 'editor';
export type ResourceRole = 'owner' | GrantRole;

export interface ResourceAccess {
  role: ResourceRole;
  ownerSubject: string;
  /** How a non-owner got in. */
  via: 'owner' | 'grant' | 'project';
}

export interface ChatAccess extends ResourceAccess {
  chat: ChatRow;
  role: 'owner' | 'viewer';
  /**
   * How this viewer opens the chat's content (chat-keys.ts): under the
   * chat's key as themselves, or — a project member — as its owner. Every
   * read and write of the chat's rows goes through it.
   */
  cipher: ContentCipher;
}

/** A project's access with the cipher for its instructions, memory and files. */
export interface ProjectAccess extends ResourceAccess {
  cipher: ContentCipher;
}

export interface GrantView {
  id: string;
  granteeSubject: string;
  granteeName: string | null;
  granteeEmail: string | null;
  role: GrantRole;
  expiresAt: string | null;
  expired: boolean;
  createdAt: string;
}

export interface GrantedResource {
  resourceId: string;
  ownerSubject: string;
  role: GrantRole;
  expiresAt: string | null;
}

export function isResourceKind(value: unknown): value is ResourceKind {
  return (
    value === 'chat' ||
    value === 'chat_project' ||
    value === 'prompt_library' ||
    value === 'artifact'
  );
}

export function isGrantRole(value: unknown): value is GrantRole {
  return value === 'viewer' || value === 'editor';
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

async function ownerOf(
  kind: ResourceKind,
  resourceId: string
): Promise<{ ownerSubject: string } | null> {
  if (!isUuid(resourceId)) return null;
  const ownerSubject = await getDataStore().resourceGrants.ownerOf(kind, resourceId);
  return ownerSubject === null ? null : { ownerSubject };
}

export async function activeGrant(
  kind: ResourceKind,
  resourceId: string,
  granteeSubject: string
): Promise<GrantRole | null> {
  if (!isUuid(resourceId)) return null;
  const role = await getDataStore().resourceGrants.activeRole(kind, resourceId, granteeSubject);
  if (role === null) return null;
  return isGrantRole(role) ? role : 'viewer';
}

/** Projects and libraries: owner or grantee; nobody else. */
export async function resolveResourceAccess(
  viewerSubject: string,
  kind: 'chat_project' | 'prompt_library',
  resourceId: string
): Promise<ResourceAccess | null> {
  const found = await ownerOf(kind, resourceId);
  if (!found) return null;
  if (found.ownerSubject === viewerSubject) {
    return { role: 'owner', ownerSubject: found.ownerSubject, via: 'owner' };
  }
  const granted = await activeGrant(kind, resourceId, viewerSubject);
  if (granted) return { role: granted, ownerSubject: found.ownerSubject, via: 'grant' };
  return null;
}

/** A project, with the cipher its content opens under (chat-keys.ts). */
export async function resolveProjectAccess(
  viewerSubject: string,
  projectId: string
): Promise<ProjectAccess | null> {
  const access = await resolveResourceAccess(viewerSubject, 'chat_project', projectId);
  if (!access) return null;
  return {
    ...access,
    cipher: await cipherFor(
      'chat_project',
      { id: projectId, ownerSubject: access.ownerSubject },
      viewerSubject,
      access.via
    ),
  };
}

/** Chats: owner, named viewer, or a fellow member of the chat's project. */
export async function resolveChatAccess(
  viewerSubject: string,
  chatId: string
): Promise<ChatAccess | null> {
  const chat = await getChatRow(chatId);
  if (!chat) return null;
  const grant = async (
    role: 'owner' | 'viewer',
    via: 'owner' | 'grant' | 'project'
  ): Promise<ChatAccess> => ({
    chat,
    role,
    ownerSubject: chat.ownerSubject,
    via,
    cipher: await cipherFor('chat', chat, viewerSubject, via),
  });
  if (chat.ownerSubject === viewerSubject) return grant('owner', 'owner');
  const granted = await activeGrant('chat', chatId, viewerSubject);
  if (granted) return grant('viewer', 'grant');
  if (chat.projectId) {
    const project = await resolveResourceAccess(viewerSubject, 'chat_project', chat.projectId);
    if (project) return grant('viewer', 'project');
  }
  return null;
}

/** The project ids this viewer may open, for listing "chats in my projects". */
export async function listAccessibleProjectIds(viewerSubject: string): Promise<string[]> {
  const [owned, granted] = await Promise.all([
    getDataStore().chatProjects.listOwned(viewerSubject),
    listGrantedResources(viewerSubject, 'chat_project'),
  ]);
  return [...new Set([...owned.map((row) => row.id), ...granted.map((row) => row.resourceId)])];
}

/**
 * Owner grants (or re-grants — the row is upserted, so sharing again just
 * refreshes the role and expiry) access to one person.
 */
export async function grantResourceAccess(
  ownerSubject: string,
  kind: ResourceKind,
  resourceId: string,
  input: { granteeSubject: string; role: GrantRole; expiresAt: Date | null }
): Promise<'OK' | 'NOT_FOUND' | 'SELF' | 'INVALID_ROLE'> {
  if (input.granteeSubject === ownerSubject) return 'SELF';
  // A chat is shared to read; an artifact to use. Neither is ever shared to edit.
  if ((kind === 'chat' || kind === 'artifact') && input.role !== 'viewer') return 'INVALID_ROLE';
  const found = await ownerOf(kind, resourceId);
  if (!found || found.ownerSubject !== ownerSubject) return 'NOT_FOUND';
  await getDataStore().resourceGrants.upsert({
    resourceKind: kind,
    resourceId,
    ownerSubject,
    granteeSubject: input.granteeSubject,
    role: input.role,
    expiresAt: input.expiresAt,
  });
  return 'OK';
}

/** The owner's "who has access" list; lapsed rows stay until deleted. */
export async function listResourceGrants(
  ownerSubject: string,
  kind: ResourceKind,
  resourceId: string
): Promise<GrantView[]> {
  if (!isUuid(resourceId)) return [];
  const rows = await getDataStore().resourceGrants.listForOwner(ownerSubject, kind, resourceId);
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    granteeSubject: row.granteeSubject,
    granteeName: row.granteeName,
    granteeEmail: row.granteeEmail,
    role: isGrantRole(row.role) ? row.role : 'viewer',
    expiresAt: iso(row.expiresAt),
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Returns the revoked grantee's subject (so a chat's key wrapping can follow), or null when nothing matched. */
export async function revokeResourceGrant(
  ownerSubject: string,
  kind: ResourceKind,
  resourceId: string,
  grantId: string
): Promise<string | null> {
  if (!isUuid(resourceId) || !isUuid(grantId)) return null;
  return getDataStore().resourceGrants.revoke(ownerSubject, kind, resourceId, grantId);
}

/** Everything of one kind shared with this person, unexpired. */
export async function listGrantedResources(
  granteeSubject: string,
  kind: ResourceKind
): Promise<GrantedResource[]> {
  const rows = await getDataStore().resourceGrants.listForGrantee(granteeSubject, kind);
  return rows.map((row) => ({
    resourceId: row.resourceId,
    ownerSubject: row.ownerSubject,
    role: isGrantRole(row.role) ? row.role : 'viewer',
    expiresAt: iso(row.expiresAt),
  }));
}
