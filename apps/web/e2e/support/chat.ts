/**
 * A chat staged the way the composer makes one: POST /api/chat/chats,
 * PATCH for its title, and each prompt sent through …/turns — the reply
 * written by the app's own turn engine against the stand-in model
 * (scripted or not, e2e/support/stub-model.ts). `send` waits for the turn
 * to settle by reading the chat back as the page does (GET
 * /api/chat/chats/:id), so the next prompt is never refused as "a reply
 * is already in progress".
 */

import { expect, type APIRequestContext } from '@playwright/test';

export interface ChatOptions {
  llmModelId: string;
  title?: string;
  projectId?: string;
  thinkingEnabled?: boolean;
  /** The connectors the chat's Tools popover turns on (`{ connectors: ['jira'] }`). */
  toolConfig?: { connectors: string[] };
}

/** What GET /api/chat/chats/:id answers, as far as the specs read it. */
export interface ChatReadBack {
  chat: {
    id: string;
    title: string | null;
    activeTurn: {
      id: string;
      status: string;
      kind: string;
      pendingPermission?: { toolUseId: string; name: string } | null;
    } | null;
    queue: { kind: string }[];
    draft: string;
    artifacts: { id: string; filename: string }[];
    contextTokens: number | null;
  };
  messages: { id: string; role: string; kind: string; content: unknown }[];
}

export async function createChat(
  request: APIRequestContext,
  options: ChatOptions
): Promise<string> {
  const created = await request.post('/api/chat/chats', {
    data: {
      llmModelId: options.llmModelId,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.thinkingEnabled ? { thinkingEnabled: true } : {}),
      ...(options.toolConfig ? { toolConfig: options.toolConfig } : {}),
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { chatId } = await created.json();
  if (options.title) await renameChat(request, chatId, options.title);
  return chatId;
}

export async function renameChat(
  request: APIRequestContext,
  chatId: string,
  title: string
): Promise<void> {
  const renamed = await request.patch(`/api/chat/chats/${chatId}`, { data: { title } });
  expect(renamed.ok(), await renamed.text()).toBe(true);
}

export async function readChat(
  request: APIRequestContext,
  chatId: string
): Promise<ChatReadBack> {
  const response = await request.get(`/api/chat/chats/${chatId}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

/** Start a turn and leave it running; answers its id. */
export async function startTurn(
  request: APIRequestContext,
  chatId: string,
  text: string,
  llmModelId?: string
): Promise<string> {
  const asked = await request.post(`/api/chat/chats/${chatId}/turns`, {
    data: { text, ...(llmModelId ? { llmModelId } : {}) },
  });
  expect(asked.status(), await asked.text()).toBe(202);
  const { turnId } = await asked.json();
  return turnId;
}

export interface SettleOptions {
  /** Answer each permission ask the turn parks on with "Allow once", as the card's button does. */
  allow?: boolean;
  timeout?: number;
}

/** Wait until the chat has no turn running. */
export async function settled(
  request: APIRequestContext,
  chatId: string,
  options: SettleOptions = {}
): Promise<ChatReadBack> {
  const deadline = Date.now() + (options.timeout ?? 60_000);
  const answered = new Set<string>();
  for (;;) {
    const view = await readChat(request, chatId);
    const turn = view.chat.activeTurn;
    if (turn === null) return view;
    const ask = turn.pendingPermission;
    if (options.allow && ask && !answered.has(ask.toolUseId)) {
      answered.add(ask.toolUseId);
      const decided = await request.post(
        `/api/chat/chats/${chatId}/turns/${turn.id}/permission`,
        { data: { toolUseId: ask.toolUseId, decision: 'once' } }
      );
      expect(decided.ok(), await decided.text()).toBe(true);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`The chat's turn never settled: ${JSON.stringify(view.chat.activeTurn)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Send a prompt and wait for its reply to be written. */
export async function send(
  request: APIRequestContext,
  chatId: string,
  text: string,
  llmModelId?: string,
  options: SettleOptions = {}
): Promise<ChatReadBack> {
  await startTurn(request, chatId, text, llmModelId);
  return settled(request, chatId, options);
}
