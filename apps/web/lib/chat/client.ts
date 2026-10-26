/**
 * The chat's client-side calls, typed once. Every function returns the
 * fetch helpers' `{ data, error }` values — a form shows a message, it
 * never throws.
 */

import type { McpToolResult } from '@renkei/mcp-client';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import type { ChatSidebarData } from './sidebar';
import type {
  AttachmentView,
  ChatMessageView,
  ChatView,
  ModelOption,
  ToolPermissionDecision,
  WidgetDecisionState,
} from './views';
import type { SubagentRunView } from './subagent-runs';
import type { ConnectorOption } from './tool-surface';
import type { GrantView, GrantRole, ResourceKind } from './access';
import type { ArtifactImpact, LibraryItem } from './artifact-library';
import type { ProjectArtifactListItem, QueuedSend } from './views';
import type { StartedTurn } from './start-turn';
import type { ChatSearchHit } from './search-text';
import type { VoiceAvailability } from '@/lib/voice/availability';
import type { WidgetModelContextOutcome } from './widget-tools';

const base = () => `/api/chat`;

/**
 * PUTs a file's bytes. `fetch` cannot report how far an upload has got, so
 * a caller that wants a progress bar gets an XHR whose upload events feed
 * it; the answer comes back as a Response either way.
 */
function putFile(
  url: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void
): Promise<Response> {
  if (!onProgress) return fetch(url, { method: 'PUT', body: file });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.total);
    xhr.onload = () => resolve(new Response(xhr.responseText, { status: xhr.status }));
    xhr.onerror = () => reject(new TypeError('network error'));
    xhr.send(file);
  });
}

/**
 * The browser's IANA zone, sent with every prompt so the model knows the
 * person's local day and time instead of guessing it (from an office
 * address, say). Undefined where Intl cannot say.
 */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export const chatClient = {
  sidebar: () => getJson<ChatSidebarData>(`${base()}/chats`),

  /** The composer's inputs — models, uploads, voice — for a box that opens on any page. */
  composerSetup: () =>
    getJson<{
      models: ModelOption[];
      uploadsEnabled: boolean;
      massUploadThreshold: number;
      voice: VoiceAvailability | null;
    }>(`${base()}/composer-setup`),

  /** The next page of the viewer's own chats older than `before` — the sidebar's "Load more". */
  moreChats: (before: string) =>
    getJson<{ chats: ChatSidebarData['chats']; nextBefore: string | null }>(
      `${base()}/chats/more?${new URLSearchParams({ before }).toString()}`
    ),

  /** The listed chats whose messages contain `query`, with a snippet each. */
  searchChats: (query: string) =>
    getJson<{ query: string; hits: ChatSearchHit[] }>(
      `${base()}/chats/search?${new URLSearchParams({ q: query }).toString()}`
    ),

  /** A sub-agent's run — its task, progress, report and full transcript — by the delegating call. */
  getSubagentRun: (chatId: string, toolUseId: string) =>
    getJson<{ run: SubagentRunView }>(
      `${base()}/chats/${chatId}/subagents/${encodeURIComponent(toolUseId)}`
    ),

  /**
   * A new chat, in a project or not. In a code project each chat works
   * in a worktree of its own, so any number may be open at once.
   */
  createChat: (input: { projectId?: string | null }) =>
    sendJsonFull<{ chatId: string; code?: string }>(`${base()}/chats`, 'POST', input),

  getChat: (chatId: string) =>
    getJson<{ chat: ChatView; messages: ChatMessageView[] }>(`${base()}/chats/${chatId}`),

  updateChat: (
    chatId: string,
    patch: {
      title?: string | null;
      llmModelId?: string | null;
      toolConfig?: { connectors: string[] } | null;
      thinkingEnabled?: boolean;
      autoMode?: boolean;
      archived?: boolean;
    }
  ) => sendJsonFull(`${base()}/chats/${chatId}`, 'PATCH', patch),

  deleteChat: (chatId: string) => sendJsonFull(`${base()}/chats/${chatId}`, 'DELETE'),

  moveChat: (chatId: string, projectId: string | null) =>
    sendJsonFull(`${base()}/chats/${chatId}/move`, 'POST', { projectId }),

  sendTurn: (
    chatId: string,
    input: { text: string; attachmentIds: string[]; llmModelId?: string | null; voice?: boolean }
  ) =>
    sendJsonFull<StartedTurn & { code?: string }>(`${base()}/chats/${chatId}/turns`, 'POST', {
      ...input,
      timeZone: browserTimeZone(),
    }),

  /** Save the composer's unsent text; empty clears it. `keepalive` lets a save finish while the page unloads. */
  saveDraft: (chatId: string, text: string, keepalive = false) =>
    sendJsonFull(`${base()}/chats/${chatId}/draft`, 'PUT', { text }, keepalive),

  /** Replace the chat's held sends with `queue` — the whole list, so a stale write cannot resurrect a sent one. */
  saveQueue: (chatId: string, queue: QueuedSend[]) =>
    sendJsonFull(`${base()}/chats/${chatId}/queue`, 'PUT', { queue }),

  /** Resend a prompt (text null = as it was), removing the replies after it. */
  resend: (
    chatId: string,
    messageId: string,
    input: {
      text: string | null;
      attachmentIds: string[];
      llmModelId?: string | null;
      voice?: boolean;
    }
  ) =>
    sendJsonFull<StartedTurn & { fromSeq: number; removedArtifactIds: string[]; code?: string }>(
      `${base()}/chats/${chatId}/messages/${messageId}/resend`,
      'POST',
      { ...input, timeZone: browserTimeZone() }
    ),

  /** The person's connected network shares, for copying a file out. */
  shares: () =>
    getJson<{
      shares: {
        id: string;
        name: string;
        protocol: string;
        host: string;
        shareName: string;
        connection: { username: string } | null;
      }[];
    }>(`/api/fileshares`),

  copyAttachment: (
    attachmentId: string,
    destination: { kind: 'fileshare-file'; shareId: string; path: string }
  ) =>
    sendJsonFull<{ ok: boolean; detail: string }>(
      `${base()}/attachments/${attachmentId}/copy`,
      'POST',
      destination
    ),

  cancelTurn: (chatId: string, turnId: string) =>
    sendJsonFull(`${base()}/chats/${chatId}/turns/${turnId}/cancel`, 'POST'),

  /** Answer the tool call a turn is waiting on: allow once, always, or deny. */
  decideToolPermission: (
    chatId: string,
    turnId: string,
    toolUseId: string,
    decision: ToolPermissionDecision
  ) =>
    sendJsonFull<{ ok: boolean; decision: ToolPermissionDecision; code?: string }>(
      `${base()}/chats/${chatId}/turns/${turnId}/permission`,
      'POST',
      { toolUseId, decision }
    ),

  /** What this person decided ahead of time about the chat's act tools (permission-prefs.ts). */
  toolPermissions: () =>
    getJson<{ alwaysAllow: string[]; alwaysDeny: string[] }>(`${base()}/tool-permissions`),

  setToolPermissions: (prefs: { alwaysAllow: string[]; alwaysDeny: string[] }) =>
    sendJsonFull<{ alwaysAllow: string[]; alwaysDeny: string[] }>(
      `${base()}/tool-permissions`,
      'PUT',
      prefs
    ),

  /** Force a compaction pass now — /compact, or "compact this chat" picked from the prompt picker. */
  compact: (chatId: string) =>
    sendJsonFull<{ turnId: string; code?: string }>(`${base()}/chats/${chatId}/compact`, 'POST'),

  streamUrl: (chatId: string, turnId: string) => `${base()}/chats/${chatId}/turns/${turnId}/stream`,

  models: () => getJson<{ models: ModelOption[] }>(`${base()}/models`),

  connectors: () =>
    getJson<{
      connectors: ConnectorOption[];
      core: string[];
      /** Where a code project starts when the person has no code default of their own. */
      codeDefault?: string[];
      /** The person's saved default for new code projects, if any. */
      userCodeDefault?: { connectors: string[] } | null;
      userDefault: { connectors: string[] } | null;
    }>(`${base()}/tools`),

  /** Save (or, with null, clear) this person's default chat toolset. */
  /** Save or clear one of the person's defaults: for new chats, or for new code projects. */
  setDefaultTools: (connectors: string[] | null, kind: 'chat' | 'code' = 'chat') =>
    sendJsonFull<{ userDefault: { connectors: string[] } | null }>(`${base()}/tools`, 'PUT', {
      userDefault: connectors ? { connectors } : null,
      kind,
    }),

  uploadAttachment: async (
    home: { chatId: string } | { projectId: string },
    file: File
  ): Promise<{ data: AttachmentView | null; error: string | null }> => {
    const query = new URLSearchParams({
      ...('chatId' in home ? { chatId: home.chatId } : { projectId: home.projectId }),
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
    });
    try {
      const response = await fetch(`${base()}/attachments?${query.toString()}`, {
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

  /** OCRs unsent files that came up needs_ocr; returns each one's new status. */
  ocrAttachments: async (
    chatId: string,
    attachmentIds: string[]
  ): Promise<Array<{ id: string; extractStatus: string }>> => {
    try {
      const response = await fetch(`${base()}/attachments/ocr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, attachmentIds }),
      });
      const body = await response.json().catch(() => null);
      return response.ok && Array.isArray(body?.results) ? body.results : [];
    } catch {
      return [];
    }
  },

  deleteAttachment: (attachmentId: string) =>
    sendJsonFull(`${base()}/attachments/${attachmentId}`, 'DELETE'),

  /** A project editor lets go of a file someone else owns: detached, not deleted. */
  detachAttachment: (attachmentId: string, projectId: string) =>
    sendJsonFull(
      `${base()}/attachments/${attachmentId}?${new URLSearchParams({ projectId }).toString()}`,
      'DELETE'
    ),

  // ---- Artifacts (lib/chat/artifact-routes.ts) ----

  /** The viewer's library: what they own and what was shared with them. */
  /** The whole library at once — the attach picker's; the Artifacts page reads pages through its own URL. */
  artifacts: () =>
    getJson<{ artifacts: LibraryItem[]; uploads: boolean }>(`${base()}/artifacts?all=1`),

  /** The artifacts whose name or contents say `query`: the library's own search, for the top bar. */
  findArtifacts: (query: string) =>
    getJson<{ artifacts: LibraryItem[] }>(
      `${base()}/artifacts?${new URLSearchParams({ q: query }).toString()}`
    ),

  artifact: (artifactId: string) =>
    getJson<{
      artifact: LibraryItem;
      access: { role: 'owner' | 'use' | 'read'; via: string; projectId: string | null };
      impact: ArtifactImpact | null;
      grants: GrantView[];
    }>(`${base()}/artifacts/${artifactId}`),

  /** Upload into the library (no home), a project, or a chat; `keep` makes a chat upload an artifact too. */
  uploadArtifact: async (
    home: { projectId?: string; chatId?: string; keep?: boolean; mode?: 'always' | 'on_demand' },
    file: File,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<{
    data: (AttachmentView & { attached?: { mode: 'always' | 'on_demand' } | null }) | null;
    error: string | null;
  }> => {
    const query = new URLSearchParams({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      ...(home.projectId ? { projectId: home.projectId } : {}),
      ...(home.chatId ? { chatId: home.chatId } : {}),
      ...(home.keep ? { keep: '1' } : {}),
      ...(home.mode ? { mode: home.mode } : {}),
    });
    try {
      const response = await putFile(`${base()}/attachments?${query.toString()}`, file, onProgress);
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          data: null,
          error:
            typeof body?.error === 'string' ? body.error : `Upload failed (${response.status})`,
        };
      }
      return {
        data: body?.attachment ? { ...body.attachment, attached: body.attached ?? null } : null,
        error: null,
      };
    } catch {
      return { data: null, error: 'Could not reach the server' };
    }
  },

  /** Starts OCR on a file the owner holds; the read goes on in the background. */
  startArtifactOcr: (artifactId: string) =>
    sendJsonFull(`${base()}/artifacts/${artifactId}/ocr`, 'POST', {}),

  renameArtifact: (artifactId: string, filename: string) =>
    sendJsonFull(`${base()}/artifacts/${artifactId}`, 'PATCH', { filename }),

  /** The owner replaces the bytes; attachments and shares stay. */
  replaceArtifact: async (artifactId: string, file: File): Promise<{ error: string | null }> => {
    const query = new URLSearchParams({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
    });
    try {
      const response = await fetch(`${base()}/artifacts/${artifactId}?${query.toString()}`, {
        method: 'PUT',
        body: file,
      });
      const body = await response.json().catch(() => null);
      return {
        error: response.ok
          ? null
          : typeof body?.error === 'string'
            ? body.error
            : `Upload failed (${response.status})`,
      };
    } catch {
      return { error: 'Could not reach the server' };
    }
  },

  /** Owner: deletes for everyone. Shared with: takes it off their list. */
  deleteArtifact: (artifactId: string) =>
    sendJsonFull<{ outcome: 'deleted' | 'left' }>(`${base()}/artifacts/${artifactId}`, 'DELETE'),

  artifactImpact: (artifactId: string) =>
    getJson<{ impact: ArtifactImpact }>(`${base()}/artifacts/${artifactId}/impact`),

  transferArtifact: (artifactId: string, newOwnerSubject: string) =>
    sendJsonFull(`${base()}/artifacts/${artifactId}/transfer`, 'POST', { newOwnerSubject }),

  copyArtifact: (
    artifactId: string,
    input: { filename?: string; attachProjectId?: string | null; mode?: 'always' | 'on_demand' }
  ) =>
    sendJsonFull<{ artifactId: string }>(`${base()}/artifacts/${artifactId}/copy`, 'POST', input),

  projectArtifacts: (projectId: string) =>
    getJson<{
      artifacts: ProjectArtifactListItem[];
      alwaysTokens: { used: number; budget: number };
      role: 'owner' | 'editor' | 'viewer';
    }>(`${base()}/projects/${projectId}/artifacts`),

  attachArtifact: (projectId: string, artifactId: string, mode: 'always' | 'on_demand') =>
    sendJsonFull<{ mode: 'always' | 'on_demand' }>(
      `${base()}/projects/${projectId}/artifacts`,
      'POST',
      {
        artifactId,
        mode,
      }
    ),

  setArtifactMode: (projectId: string, artifactId: string, mode: 'always' | 'on_demand') =>
    sendJsonFull<{ alwaysTokens: number }>(
      `${base()}/projects/${projectId}/artifacts/${artifactId}`,
      'PATCH',
      { mode }
    ),

  detachArtifact: (projectId: string, artifactId: string) =>
    sendJsonFull(`${base()}/projects/${projectId}/artifacts/${artifactId}`, 'DELETE'),

  attachmentUrl: (attachmentId: string) => `${base()}/attachments/${attachmentId}`,
  /** The text the file holds (its OCR read, or the text it had), as a download. */
  attachmentTextUrl: (attachmentId: string) => `${base()}/attachments/${attachmentId}/text`,

  grants: (kind: ResourceKind, resourceId: string) =>
    getJson<{ grants: GrantView[] }>(`${base()}/${grantPath(kind, resourceId)}`),

  grant: (
    kind: ResourceKind,
    resourceId: string,
    input: { granteeSubject: string; role: GrantRole; expiresAt: string | null }
  ) => sendJsonFull(`${base()}/${grantPath(kind, resourceId)}`, 'POST', input),

  revoke: (kind: ResourceKind, resourceId: string, grantId: string) =>
    sendJsonFull(`${base()}/${grantPath(kind, resourceId)}/${grantId}`, 'DELETE'),

  people: () =>
    getJson<{ people: { subject: string; email: string; displayName: string | null }[] }>(
      `${base()}/people`
    ),

  /** The HTML document of one chat_show_mockup call (mockup-card.tsx's iframe src). */
  mockupUrl: (chatId: string, toolUseId: string) =>
    `${base()}/chats/${chatId}/mockups/${encodeURIComponent(toolUseId)}`,

  /** Where a widget card's `ui://` resource HTML is served (widget-card.tsx's iframe src). */
  widgetResourceUrl: (resourceUri: string) =>
    `${base()}/widgets?${new URLSearchParams({ uri: resourceUri }).toString()}`,

  /**
   * A card's confirm button, run for real (widget-card.tsx's `tools/call`
   * proxy). `stateKey` — the card's own persistence key — lets the server
   * refuse the call when another device already decided this exact card,
   * rather than running a non-idempotent confirm tool a second time.
   */
  confirmWidgetTool: (
    chatId: string,
    name: string,
    args: Record<string, unknown>,
    stateKey?: string
  ) =>
    sendJsonFull<{ result: McpToolResult }>(`${base()}/chats/${chatId}/widget/tool-call`, 'POST', {
      name,
      arguments: args,
      ...(stateKey ? { stateKey } : {}),
    }),

  /**
   * A card's decision, once it finishes (bridge.ts's `reportDecision`) —
   * recorded so the same card, opened on another device or after a reload,
   * shows this receipt instead of live Confirm/Cancel buttons.
   */
  reportWidgetDecision: (
    chatId: string,
    stateKey: string,
    decision: 'confirmed' | 'cancelled',
    state: WidgetDecisionState
  ) =>
    sendJsonFull(`${base()}/chats/${chatId}/widget/decision`, 'POST', {
      stateKey,
      decision,
      state,
    }),

  /**
   * A card's `ui/update-model-context` — recorded as a note and, when the
   * chat can take one, the user row of a new turn the model answers at
   * once (`turn` carries the ids to stream from; null when only the note
   * was written, including when `stateKey` names a card whose reply still
   * has an undecided sibling — the model answers once every card in that
   * reply has one, not once per card).
   */
  appendWidgetModelContext: (chatId: string, text: string, stateKey?: string) =>
    sendJsonFull<WidgetModelContextOutcome>(
      `${base()}/chats/${chatId}/widget/model-context`,
      'POST',
      { text, ...(stateKey ? { stateKey } : {}) }
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
    case 'artifact':
      return `artifacts/${resourceId}/grants`;
  }
}
