/**
 * Temporary chats: a chat started as temporary gets none of the person's
 * memories — no memory in its prompt, no memory tools to read or keep
 * one, the user-memory connector left off its tool surface, no recall of
 * the person's other chats, and a call to any of them anyway refused
 * without a permission ask — and it is nobody's memory either: other
 * chats' recall leaves it out. After TEMPORARY_CHAT_IDLE_HOURS without
 * activity the retention sweep deletes it, with what it holds
 * (apps/worker-agents/src/chat-sweep.ts); it is never archived instead.
 *
 * It stands outside projects, since a project would give it the project's
 * memory, and it becomes temporary (or stops being) only before its first
 * message: a chat that has already been shown memories stays as it is.
 */

import { USER_MEMORY_CONNECTOR } from '@/lib/mcp-tools/user-memory';
import type { ChatToolConfig } from './tool-config';

/** How long a temporary chat may sit untouched before it is deleted. */
export const TEMPORARY_CHAT_IDLE_HOURS = 24;

export const TEMPORARY_OUTSIDE_PROJECTS =
  'A temporary chat stays outside projects: a project would give it the project’s memory.';

export const TEMPORARY_ONLY_WHEN_EMPTY =
  'A chat becomes temporary, or stops being, only before its first message.';

/** Every tool that reads or keeps a memory, or recalls another chat. */
export const MEMORY_TOOL_NAMES = [
  'chat_memory_remember',
  'chat_memory_forget',
  'chat_memory_list',
  'project_memory_remember',
  'project_memory_forget',
  'project_memory_list',
  'chat_recall_chats',
  'user_memory_list',
] as const;

/** What the model is told when it calls one anyway, from a guess or another chat. */
export const TEMPORARY_MEMORY_REFUSAL =
  'This is a temporary chat: it has no access to the person’s memories or other chats, so nothing can be read from or saved to memory here. Do not retry; if something should be remembered, tell the person to save it in an ordinary chat or on the Memory page.';

/** The memory tools, each refused with TEMPORARY_MEMORY_REFUSAL (turn-runner.ts `unavailable`). */
export function temporaryUnavailableTools(): ReadonlyMap<string, string> {
  return new Map(MEMORY_TOOL_NAMES.map((name) => [name, TEMPORARY_MEMORY_REFUSAL]));
}

/** The tool config with the memory connectors taken off. */
export function withoutMemoryConnectors(config: ChatToolConfig): ChatToolConfig {
  return { connectors: config.connectors.filter((key) => key !== USER_MEMORY_CONNECTOR) };
}
