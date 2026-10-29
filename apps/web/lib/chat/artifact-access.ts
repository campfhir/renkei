/**
 * Who may do what with an artifact, and the cipher its text opens under
 * (docs/artifacts-design.md). One row, four doors:
 *
 *   - its OWNER (the person who uploaded it, or whose chat produced it):
 *     everything — rename, replace, share, hand over, delete;
 *   - a person it is SHARED with (resource_access_grants, kind
 *     `artifact`): may USE it — read it, attach it to their own projects,
 *     copy it, take it off their own list — never change it;
 *   - a MEMBER of a project that holds it: may READ it in that project;
 *     the project's owner and editors also attach, detach and set how the
 *     project's chats use it;
 *   - a READER of the chat it was uploaded to or produced in.
 *
 * The cipher follows the row's `key_kind`: its own key (opened as the
 * owner, through the share's wrapping, or through the project's or chat's
 * wrapping of it — chat-keys.ts), or the chat's or project's key for a
 * row that still lives under where it was uploaded. Nobody else
 * resolves: null, which routes surface as 404.
 */

import { isUuid } from '@/lib/uuid';
import { activeGrant, resolveChatAccess, resolveResourceAccess, type ResourceRole } from './access';
import { getAttachment, listReferencesOf, type AttachmentRow } from './attachments';
import { chatCipherById, cipherFor, projectCipherById } from './chat-keys';
import { unavailableCipher, type ContentCipher } from './content-crypto';

export type ArtifactRole = 'owner' | 'use' | 'read';

export interface ArtifactAccess {
  row: AttachmentRow;
  role: ArtifactRole;
  via: 'owner' | 'grant' | 'project' | 'chat';
  /** The project the viewer reads it through, with the viewer's role there. */
  projectId: string | null;
  projectRole: ResourceRole | null;
  cipher: ContentCipher;
}

/** The cipher for a row, given how the viewer got in. */
export async function artifactCipher(
  row: AttachmentRow,
  viewerSubject: string,
  via: ArtifactAccess['via'],
  parentId: string | null
): Promise<ContentCipher> {
  if (row.keyKind === 'chat') {
    if (!row.keyRef) return unavailableCipher('no-key');
    const chat = await resolveChatAccess(viewerSubject, row.keyRef);
    if (chat) return chat.cipher;
    // The owner of a row whose chat is gone from under them, or a reader
    // the row reached another way: as the chat's owner, if that still opens.
    return chatCipherById(row.keyRef);
  }
  if (row.keyKind === 'chat_project') {
    if (!row.keyRef) return unavailableCipher('no-key');
    const project = await resolveResourceAccess(viewerSubject, 'chat_project', row.keyRef);
    if (project) {
      return cipherFor(
        'chat_project',
        { id: row.keyRef, ownerSubject: project.ownerSubject },
        viewerSubject,
        project.via
      );
    }
    return projectCipherById(row.keyRef);
  }
  return cipherFor(
    'artifact',
    { id: row.id, ownerSubject: row.ownerSubject },
    viewerSubject,
    via,
    parentId
  );
}

/**
 * How this viewer may reach the artifact, or null. `preferProjectId`
 * names the project the viewer is working in, so a member reads a file
 * through the project they are in rather than another that also holds it.
 */
export async function resolveArtifactAccess(
  viewerSubject: string,
  artifact: string | AttachmentRow,
  preferProjectId: string | null = null
): Promise<ArtifactAccess | null> {
  const row = typeof artifact === 'string' ? await getAttachment(artifact) : artifact;
  if (!row) return null;
  const done = async (
    role: ArtifactRole,
    via: ArtifactAccess['via'],
    projectId: string | null,
    projectRole: ResourceRole | null,
    chatId: string | null
  ): Promise<ArtifactAccess> => ({
    row,
    role,
    via,
    projectId,
    projectRole,
    cipher: await artifactCipher(
      row,
      viewerSubject,
      via,
      via === 'project' ? projectId : via === 'chat' ? chatId : null
    ),
  });
  if (row.ownerSubject === viewerSubject) return done('owner', 'owner', null, 'owner', null);
  if (await activeGrant('artifact', row.id, viewerSubject)) {
    return done('use', 'grant', null, null, null);
  }
  const references = await listReferencesOf(row.id);
  const ordered = preferProjectId
    ? [
        ...references.filter((r) => r.projectId === preferProjectId),
        ...references.filter((r) => r.projectId !== preferProjectId),
      ]
    : references;
  for (const reference of ordered) {
    const project = await resolveResourceAccess(viewerSubject, 'chat_project', reference.projectId);
    if (project) return done('read', 'project', reference.projectId, project.role, null);
  }
  if (row.chatId && isUuid(row.chatId)) {
    const chat = await resolveChatAccess(viewerSubject, row.chatId);
    if (chat) return done('read', 'chat', null, null, row.chatId);
  }
  return null;
}

/** The cipher this reader opens the file's text with, or null when they may not read it. */
export async function attachmentCipherFor(
  subject: string,
  row: AttachmentRow
): Promise<ContentCipher | null> {
  const access = await resolveArtifactAccess(subject, row);
  return access?.cipher ?? null;
}

/**
 * The cipher a turn's tool opens one of the chat's or its project's files
 * with: the chat's own cipher, which the turn already holds, for a file
 * still under the chat's key; else whatever access the person has to it.
 */
export async function fileCipherFor(
  scope: {
    subject: string;
    chatId: string;
    cipher: ContentCipher;
    projectId?: string | null;
  },
  row: AttachmentRow
): Promise<ContentCipher | null> {
  if (row.keyKind === 'chat' && row.keyRef === scope.chatId) return scope.cipher;
  const access = await resolveArtifactAccess(scope.subject, row, scope.projectId ?? null);
  return access?.cipher ?? null;
}

/** Owner, or a person it is shared with: the two who may attach it to their own projects. */
export function mayUse(access: ArtifactAccess): boolean {
  return access.role === 'owner' || access.role === 'use';
}
