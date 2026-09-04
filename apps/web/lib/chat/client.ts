/**
 * The chat's client-side calls, typed once. Every function returns the
 * fetch helpers' `{ data, error }` values — a form shows a message, it
 * never throws.
 */

import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { ChatSidebarData } from './sidebar';
import type { AttachmentView, ChatMessageView, ChatView, ModelOption } from './views';
import type { ConnectorOption } from './tool-surface';
import type { GrantView, GrantRole, ResourceKind } from './access';
import type { StartedTurn } from './start-turn';

const base = (tenantId: string) => `/api/tenant/${tenantId}/chat`;

export const chatClient = {
  sidebar: (tenantId: string) => getJson<ChatSidebarData>(`${base(tenantId)}/chats`),

  createChat: (
    tenantId: string,
    input: { projectId?: string | null; llmModelId?: string | null; thinkingEnabled?: boolean }
  ) => sendJsonFull<{ chatId: string }>(`${base(tenantId)}/chats`, 'POST', input),

  getChat: (tenantId: string, chatId: string) =>
    getJson<{ chat: ChatView; messages: ChatMessageView[] }>(`${base(tenantId)}/chats/${chatId}`),

  updateChat: (
    tenantId: string,
    chatId: string,
    patch: {
      title?: string | null;
      llmModelId?: string | null;
      toolConfig?: { connectors: string[] } | null;
      thinkingEnabled?: boolean;
      archived?: boolean;
    }
  ) => sendJsonFull(`${base(tenantId)}/chats/${chatId}`, 'PATCH', patch),

  deleteChat: (tenantId: string, chatId: string) =>
    sendJsonFull(`${base(tenantId)}/chats/${chatId}`, 'DELETE'),

  moveChat: (tenantId: string, chatId: string, projectId: string | null) =>
    sendJsonFull(`${base(tenantId)}/chats/${chatId}/move`, 'POST', { projectId }),

  sendTurn: (
    tenantId: string,
    chatId: string,
    input: { text: string; attachmentIds: string[]; llmModelId?: string | null }
  ) =>
    sendJsonFull<StartedTurn & { code?: string }>(
      `${base(tenantId)}/chats/${chatId}/turns`,
      'POST',
      input
    ),

  /** Resend a prompt (text null = as it was), removing the replies after it. */
  resend: (
    tenantId: string,
    chatId: string,
    messageId: string,
    input: { text: string | null; attachmentIds: string[]; llmModelId?: string | null }
  ) =>
    sendJsonFull<StartedTurn & { fromSeq: number; removedArtifactIds: string[]; code?: string }>(
      `${base(tenantId)}/chats/${chatId}/messages/${messageId}/resend`,
      'POST',
      input
    ),

  /** The person's connected network shares, for copying a file out. */
  shares: (tenantId: string) =>
    getJson<{
      shares: {
        id: string;
        name: string;
        protocol: string;
        host: string;
        shareName: string;
        connection: { username: string } | null;
      }[];
    }>(`/api/tenant/${tenantId}/fileshares`),

  copyAttachment: (
    tenantId: string,
    attachmentId: string,
    destination: { kind: 'fileshare-file'; shareId: string; path: string }
  ) =>
    sendJsonFull<{ ok: boolean; detail: string }>(
      `${base(tenantId)}/attachments/${attachmentId}/copy`,
      'POST',
      destination
    ),

  cancelTurn: (tenantId: string, chatId: string, turnId: string) =>
    sendJsonFull(`${base(tenantId)}/chats/${chatId}/turns/${turnId}/cancel`, 'POST'),

  streamUrl: (tenantId: string, chatId: string, turnId: string) =>
    `${base(tenantId)}/chats/${chatId}/turns/${turnId}/stream`,

  models: (tenantId: string) => getJson<{ models: ModelOption[] }>(`${base(tenantId)}/models`),

  connectors: (tenantId: string) =>
    getJson<{ connectors: ConnectorOption[]; core: string[] }>(`${base(tenantId)}/tools`),

  uploadAttachment: async (
    tenantId: string,
    home: { chatId: string } | { projectId: string },
    file: File
  ): Promise<{ data: AttachmentView | null; error: string | null }> => {
    const query = new URLSearchParams({
      ...('chatId' in home ? { chatId: home.chatId } : { projectId: home.projectId }),
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
    });
    try {
      const response = await fetch(`${base(tenantId)}/attachments?${query.toString()}`, {
        method: 'PUT',
        body: file,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          data: null,
          error:
            typeof body?.error === 'string' ? body.error : `Upload failed (${response.status})`,
        };
      }
      return { data: body?.attachment ?? null, error: null };
    } catch {
      return { data: null, error: 'Could not reach the server' };
    }
  },

  deleteAttachment: (tenantId: string, attachmentId: string) =>
    sendJsonFull(`${base(tenantId)}/attachments/${attachmentId}`, 'DELETE'),

  attachmentUrl: (tenantId: string, attachmentId: string) =>
    `${base(tenantId)}/attachments/${attachmentId}`,

  grants: (tenantId: string, kind: ResourceKind, resourceId: string) =>
    getJson<{ grants: GrantView[] }>(`${base(tenantId)}/${grantPath(kind, resourceId)}`),

  grant: (
    tenantId: string,
    kind: ResourceKind,
    resourceId: string,
    input: { granteeSubject: string; role: GrantRole; expiresAt: string | null }
  ) => sendJsonFull(`${base(tenantId)}/${grantPath(kind, resourceId)}`, 'POST', input),

  revoke: (tenantId: string, kind: ResourceKind, resourceId: string, grantId: string) =>
    sendJsonFull(`${base(tenantId)}/${grantPath(kind, resourceId)}/${grantId}`, 'DELETE'),

  publish: (tenantId: string, kind: 'chat_project' | 'prompt_library', id: string, on: boolean) =>
    sendJsonFull(
      `${base(tenantId)}/${kind === 'chat_project' ? 'projects' : 'prompt-libraries'}/${id}`,
      'PATCH',
      { publishedToOrg: on }
    ),

  people: (tenantId: string) =>
    getJson<{ people: { subject: string; email: string; displayName: string | null }[] }>(
      `${base(tenantId)}/people`
    ),
};

function grantPath(kind: ResourceKind, resourceId: string): string {
  switch (kind) {
    case 'chat':
      return `chats/${resourceId}/grants`;
    case 'chat_project':
      return `projects/${resourceId}/grants`;
    case 'prompt_library':
      return `prompt-libraries/${resourceId}/grants`;
  }
}
