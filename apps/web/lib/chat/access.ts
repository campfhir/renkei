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

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { getChatRow, type ChatRow } from './store';
import { cipherFor } from './chat-keys';
import type { ContentCipher } from './content-crypto';

export type ResourceKind = 'chat' | 'chat_project' | 'prompt_library';
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
  return value === 'chat' || value === 'chat_project' || value === 'prompt_library';
}

export function isGrantRole(value: unknown): value is GrantRole {
  return value === 'viewer' || value === 'editor';
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

async function ownerOf(
  db: Kysely<DB>,
  tenantId: string,
  kind: ResourceKind,
  resourceId: string
): Promise<{ ownerSubject: string } | null> {
  if (!isUuid(resourceId)) return null;
  const table =
    kind === 'chat' ? 'chats' : kind === 'chat_project' ? 'chat_projects' : 'prompt_libraries';
  const row = await db
    .selectFrom(table)
    .select('owner_subject')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', resourceId)
    .executeTakeFirst();
  return row ? { ownerSubject: row.owner_subject } : null;
}

async function activeGrant(
  db: Kysely<DB>,
  tenantId: string,
  kind: ResourceKind,
  resourceId: string,
  granteeSubject: string
): Promise<GrantRole | null> {
  const row = await db
    .selectFrom('resource_access_grants')
    .select('role')
    .where('tenant_id', '=', tenantId)
    .where('resource_kind', '=', kind)
    .where('resource_id', '=', resourceId)
    .where('grantee_subject', '=', granteeSubject)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`NOW()`)]))
    .executeTakeFirst();
  if (!row) return null;
  return isGrantRole(row.role) ? row.role : 'viewer';
}

/** Projects and libraries: owner or grantee; nobody else. */
export async function resolveResourceAccess(
  db: Kysely<DB>,
  tenantId: string,
  viewerSubject: string,
  kind: 'chat_project' | 'prompt_library',
  resourceId: string
): Promise<ResourceAccess | null> {
  const found = await ownerOf(db, tenantId, kind, resourceId);
  if (!found) return null;
  if (found.ownerSubject === viewerSubject) {
    return { role: 'owner', ownerSubject: found.ownerSubject, via: 'owner' };
  }
  const granted = await activeGrant(db, tenantId, kind, resourceId, viewerSubject);
  if (granted) return { role: granted, ownerSubject: found.ownerSubject, via: 'grant' };
  return null;
}

/** A project, with the cipher its content opens under (chat-keys.ts). */
export async function resolveProjectAccess(
  db: Kysely<DB>,
  tenantId: string,
  viewerSubject: string,
  projectId: string
): Promise<ProjectAccess | null> {
  const access = await resolveResourceAccess(
    db,
    tenantId,
    viewerSubject,
    'chat_project',
    projectId
  );
  if (!access) return null;
  return {
    ...access,
    cipher: await cipherFor(
      db,
      'chat_project',
      { id: projectId, tenantId, ownerSubject: access.ownerSubject },
      viewerSubject,
      access.via
    ),
  };
}

/** Chats: owner, named viewer, or a fellow member of the chat's project. */
export async function resolveChatAccess(
  db: Kysely<DB>,
  tenantId: string,
  viewerSubject: string,
  chatId: string
): Promise<ChatAccess | null> {
  const chat = await getChatRow(db, tenantId, chatId);
  if (!chat) return null;
  const grant = async (
    role: 'owner' | 'viewer',
    via: 'owner' | 'grant' | 'project'
  ): Promise<ChatAccess> => ({
    chat,
    role,
    ownerSubject: chat.ownerSubject,
    via,
    cipher: await cipherFor(db, 'chat', chat, viewerSubject, via),
  });
  if (chat.ownerSubject === viewerSubject) return grant('owner', 'owner');
  const granted = await activeGrant(db, tenantId, 'chat', chatId, viewerSubject);
  if (granted) return grant('viewer', 'grant');
  if (chat.projectId) {
    const project = await resolveResourceAccess(
      db,
      tenantId,
      viewerSubject,
      'chat_project',
      chat.projectId
    );
    if (project) return grant('viewer', 'project');
  }
  return null;
}

/** The project ids this viewer may open, for listing "chats in my projects". */
export async function listAccessibleProjectIds(
  db: Kysely<DB>,
  tenantId: string,
  viewerSubject: string
): Promise<string[]> {
  const [owned, granted] = await Promise.all([
    db
      .selectFrom('chat_projects')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('owner_subject', '=', viewerSubject)
      .execute(),
    listGrantedResources(db, tenantId, viewerSubject, 'chat_project'),
  ]);
  return [...new Set([...owned.map((row) => row.id), ...granted.map((row) => row.resourceId)])];
}

/**
 * Owner grants (or re-grants — the row is upserted, so sharing again just
 * refreshes the role and expiry) access to one person.
 */
export async function grantResourceAccess(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  kind: ResourceKind,
  resourceId: string,
  input: { granteeSubject: string; role: GrantRole; expiresAt: Date | null }
): Promise<'OK' | 'NOT_FOUND' | 'SELF' | 'INVALID_ROLE'> {
  if (input.granteeSubject === ownerSubject) return 'SELF';
  if (kind === 'chat' && input.role !== 'viewer') return 'INVALID_ROLE';
  const found = await ownerOf(db, tenantId, kind, resourceId);
  if (!found || found.ownerSubject !== ownerSubject) return 'NOT_FOUND';
  await db
    .insertInto('resource_access_grants')
    .values({
      tenant_id: tenantId,
      resource_kind: kind,
      resource_id: resourceId,
      owner_subject: ownerSubject,
      grantee_subject: input.granteeSubject,
      role: input.role,
      expires_at: input.expiresAt,
    })
    .onConflict((oc) =>
      oc
        .columns(['resource_kind', 'resource_id', 'grantee_subject'])
        .doUpdateSet({ role: input.role, expires_at: input.expiresAt })
    )
    .execute();
  return 'OK';
}

/** The owner's "who has access" list; lapsed rows stay until deleted. */
export async function listResourceGrants(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  kind: ResourceKind,
  resourceId: string
): Promise<GrantView[]> {
  if (!isUuid(resourceId)) return [];
  const rows = await db
    .selectFrom('resource_access_grants as g')
    .leftJoin('identities as i', (join) =>
      join.onRef('i.tenant_id', '=', 'g.tenant_id').onRef('i.subject', '=', 'g.grantee_subject')
    )
    .select([
      'g.id',
      'g.grantee_subject',
      'g.role',
      'g.expires_at',
      'g.created_at',
      'i.display_name',
      'i.email',
    ])
    .where('g.tenant_id', '=', tenantId)
    .where('g.resource_kind', '=', kind)
    .where('g.resource_id', '=', resourceId)
    .where('g.owner_subject', '=', ownerSubject)
    .orderBy('g.created_at', 'desc')
    .execute();
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    granteeSubject: row.grantee_subject,
    granteeName: row.display_name,
    granteeEmail: row.email,
    role: isGrantRole(row.role) ? row.role : 'viewer',
    expiresAt: iso(row.expires_at),
    expired: row.expires_at !== null && row.expires_at.getTime() <= now,
    createdAt: row.created_at.toISOString(),
  }));
}

/** Returns the revoked grantee's subject (so a chat's key wrapping can follow), or null when nothing matched. */
export async function revokeResourceGrant(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  kind: ResourceKind,
  resourceId: string,
  grantId: string
): Promise<string | null> {
  if (!isUuid(resourceId) || !isUuid(grantId)) return null;
  const deleted = await db
    .deleteFrom('resource_access_grants')
    .where('tenant_id', '=', tenantId)
    .where('resource_kind', '=', kind)
    .where('resource_id', '=', resourceId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', grantId)
    .returning('grantee_subject')
    .executeTakeFirst();
  return deleted?.grantee_subject ?? null;
}

/** Everything of one kind shared with this person, unexpired. */
export async function listGrantedResources(
  db: Kysely<DB>,
  tenantId: string,
  granteeSubject: string,
  kind: ResourceKind
): Promise<GrantedResource[]> {
  const rows = await db
    .selectFrom('resource_access_grants')
    .select(['resource_id', 'owner_subject', 'role', 'expires_at'])
    .where('tenant_id', '=', tenantId)
    .where('resource_kind', '=', kind)
    .where('grantee_subject', '=', granteeSubject)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`NOW()`)]))
    .execute();
  return rows.map((row) => ({
    resourceId: row.resource_id,
    ownerSubject: row.owner_subject,
    role: isGrantRole(row.role) ? row.role : 'viewer',
    expiresAt: iso(row.expires_at),
  }));
}
