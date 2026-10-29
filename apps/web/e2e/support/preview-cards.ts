/**
 * A chat whose reply holds Jira preview cards (MCP Apps widgets,
 * lib/mcp-tools/widgets.ts), made the way a person's assistant makes one:
 * Jira connected for the person (connectJira, ./connectors.ts), then a real turn on the
 * stand-in model whose prompt scripts `jira_create_issue_preview` — a
 * preview reaches no vendor, so the card's tool result is the app's own.
 * Its `previewId`s are read back from the chat as the page reads it.
 */

import { expect, type Page } from '@playwright/test';
import { createChat, readChat, send } from './chat';
import { scripted, type StubStep } from './stub-model';

export const ISSUE_INPUT = {
  projectKey: 'OPS',
  issueType: 'Task',
  summary: 'Rotate the Zoom webhook secret',
  priority: 'High',
  description: 'The current secret is six months old.',
};

export const preview = (input: Record<string, unknown>) => ({
  name: 'jira_create_issue_preview',
  input,
});

/**
 * A chat whose first reply calls the previews in `steps[0]`, allowed once
 * as the person would; answers its id and each card's previewId in order.
 */
export async function previewChat(
  page: Page,
  options: { modelId: string; title: string; prompt: string; steps: StubStep[] }
): Promise<{ chatId: string; previewIds: string[] }> {
  const chatId = await createChat(page.request, {
    llmModelId: options.modelId,
    title: options.title,
    toolConfig: { connectors: ['jira'] },
  });
  const view = await send(
    page.request,
    chatId,
    scripted(options.prompt, options.steps),
    options.modelId,
    { allow: true }
  );
  const previewIds = view.messages.flatMap((message) => {
    return message.blocks.flatMap((block: unknown) => {
      const content: unknown =
        typeof block === 'object' && block !== null
          ? Reflect.get(block, 'structuredContent')
          : null;
      const id: unknown =
        typeof content === 'object' && content !== null ? Reflect.get(content, 'previewId') : null;
      return typeof id === 'string' ? [id] : [];
    });
  });
  expect(previewIds, JSON.stringify(view.messages)).toHaveLength(
    options.steps[0]?.tools?.length ?? 0
  );
  return { chatId, previewIds };
}

/** The chat's turns so far, counted off its messages, and whether one is running. */
export async function turnsOf(
  page: Page,
  chatId: string
): Promise<{ turns: number; running: boolean; notes: number }> {
  const view = await readChat(page.request, chatId);
  const turns = new Set(view.messages.map((message) => message.turnId).filter(Boolean));
  return {
    turns: turns.size,
    running: view.chat.activeTurn !== null,
    notes: view.messages.filter((message) => message.kind === 'note').length,
  };
}
