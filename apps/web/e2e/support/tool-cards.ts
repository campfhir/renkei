/**
 * A chat whose reply carries preview cards (act previews, the email
 * composer, the ADManager card): what a vendor tool — Jira, Graph,
 * ADManager — answers the model with, which the memory server has no way
 * to produce (the tools need the person's grant on that vendor).
 *
 * Everything else is real. The chat is made through the chat's own
 * routes on the stand-in model (e2e/support/stub-model.ts); the person
 * types the prompt and presses Send; the turn runs on the server, to the
 * end. Only the turn's stream (GET …/turns/:turnId/stream, what the
 * thread listens to) is answered at the browser edge: once the real
 * stream has finished, the page is handed the turn's rows as the vendor's
 * tool would have left them — the prompt, the model's tool calls, their
 * results with the cards — in a `snapshot` event, then the real turn_end.
 * The cards then load the real built bundles from the real widget route,
 * and their buttons post to the real decision and model-context routes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** The `ui://` address of a built widget bundle (lib/mcp-widgets/generated). */
export function widgetUri(generatedFile: string, name: string): string {
  const source = readFileSync(
    path.join(import.meta.dirname, '..', '..', 'lib', 'mcp-widgets', 'generated', generatedFile),
    'utf8'
  );
  const match = source.match(/_HASH: string = "([0-9a-f]+)"/);
  if (!match) throw new Error(`No hash constant found in ${generatedFile}`);
  return `ui://widget/${name}.${match[1]}.html`;
}

export interface ToolCard {
  toolUseId: string;
  /** The tool the model called. */
  tool: string;
  input: Record<string, unknown>;
  /** What the tool told the model. */
  content: string;
  uiResourceUri: string;
  structuredContent: Record<string, unknown>;
}

/** A chat on the given model, titled, as "+ New" and a rename make it. */
export async function createChat(
  request: APIRequestContext,
  options: { modelId: string; title: string }
): Promise<string> {
  const created = await request.post('/api/chat/chats', {
    data: { llmModelId: options.modelId },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { chatId } = await created.json();
  const renamed = await request.patch(`/api/chat/chats/${chatId}`, {
    data: { title: options.title },
  });
  expect(renamed.ok(), await renamed.text()).toBe(true);
  return String(chatId);
}

interface SseEvent {
  type?: string;
  seq?: number;
  turnId?: string;
}

function eventsOf(body: string): SseEvent[] {
  return body.split('\n\n').flatMap((frame) => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (!data) return [];
    try {
      const parsed: unknown = JSON.parse(data);
      return typeof parsed === 'object' && parsed !== null ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

/** The rows one answered stream put on the page. */
export type ShownRows = Record<string, unknown>[];

function row(
  turnId: string,
  seq: number,
  role: 'user' | 'assistant',
  kind: string,
  blocks: unknown[],
  modelId: string
): Record<string, unknown> {
  const assistant = role === 'assistant';
  return {
    id: `e2e-${turnId}-${seq}`,
    turnId,
    seq,
    role,
    kind,
    status: 'complete',
    blocks,
    llmModelId: assistant ? modelId : null,
    provider: assistant ? 'openai' : null,
    model: assistant ? 'stub-model' : null,
    stopReason: assistant ? 'tool_use' : null,
    usage: null,
    error: null,
    createdAt: new Date().toISOString(),
    attachments: [],
  };
}

/**
 * Type `prompt` into the open chat's composer and send it; the turn's
 * stream shows `cards` as the reply. Answers the rows shown.
 */
export async function sendForCards(
  page: Page,
  options: {
    chatId: string;
    modelId: string;
    prompt: string;
    assistantText: string;
    cards: ToolCard[];
  }
): Promise<ShownRows> {
  let shown: ShownRows = [];
  await page.route(
    `**/api/chat/chats/${options.chatId}/turns/*/stream`,
    async (route) => {
      const turnId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
      // The real turn, to its end: the server's own events, ending in turn_end.
      const real = await route.fetch();
      const events = eventsOf(await real.text());
      const firstReply = events.find((event) => event.type === 'message_start')?.seq ?? 2;
      const ended = events.find((event) => event.type === 'turn_end') ?? {
        type: 'turn_end',
        turnId,
        status: 'completed',
        error: null,
      };
      const prompt = firstReply - 1;
      shown = [
        row(turnId, prompt, 'user', 'prompt', [{ type: 'text', text: options.prompt }], ''),
        row(
          turnId,
          firstReply,
          'assistant',
          'assistant',
          [
            { type: 'text', text: options.assistantText },
            ...options.cards.map((card) => ({
              type: 'tool_use',
              id: card.toolUseId,
              name: card.tool,
              input: card.input,
            })),
          ],
          options.modelId
        ),
        // Between the reply and whatever the server writes next.
        row(
          turnId,
          firstReply + 0.5,
          'user',
          'tool_results',
          options.cards.map((card) => ({
            type: 'tool_result',
            toolUseId: card.toolUseId,
            content: card.content,
            uiResourceUri: card.uiResourceUri,
            structuredContent: card.structuredContent,
          })),
          ''
        ),
      ];
      const snapshot = {
        type: 'snapshot',
        turn: {
          id: turnId,
          status: 'completed',
          kind: 'reply',
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
        messages: shown,
      };
      const frame = (event: unknown) => `event: turn\ndata: ${JSON.stringify(event)}\n\n`;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: frame(snapshot) + frame(ended),
      });
    },
    { times: 1 }
  );
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(options.prompt);
  await box.press('Enter');
  await expect.poll(() => shown.length, { timeout: 60_000 }).toBeGreaterThan(0);
  return shown;
}
