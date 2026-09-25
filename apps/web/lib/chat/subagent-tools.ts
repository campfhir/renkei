/**
 * The names of the tools that hand work to a sub-agent, and nothing
 * else — so the thread (segment.ts, message-list.tsx) can tell a
 * delegation from any other call without pulling a model loop into the
 * browser bundle. The tools themselves: `code_delegate` in
 * lib/code/delegate.ts (a code project's checkout), `chat_delegate` in
 * lib/chat/chat-delegate.ts (any other chat's reading tools).
 */

/** A code project's sub-agent, over the checkout's tools. */
export const CODE_DELEGATE_TOOL = 'code_delegate';

/** An ordinary chat's sub-agent, over the chat's reading tools. */
export const CHAT_DELEGATE_TOOL = 'chat_delegate';

/** Whether a call started a sub-agent: the thread gives it a card of its own. */
export function isSubagentTool(name: string): boolean {
  return name === CODE_DELEGATE_TOOL || name === CHAT_DELEGATE_TOOL;
}
