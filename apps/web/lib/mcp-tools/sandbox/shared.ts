/**
 * Helpers the sandbox_* and sandbox_browser_* tool modules share: result
 * shaping, the caller's (subject, scope) target, and the one-line
 * description of a staged file every stage tool answers with.
 */

import type { MCPToolContext } from '../common';
import type { SandboxTarget, WireSandboxFile } from '@/lib/sandbox/service-client';

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The sandbox instance assignment an agent's calls go by. An agent acts
 * as its owner — the owner's scratch space, grants and uid — but its runs
 * are served by an instance of the agent's own choosing, the same one run
 * after run, as a code project's are: a person's agents do not all pile
 * onto the instance their own chats use, and one agent's browser and
 * working files stay where its last run left them.
 */
export function agentRoute(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * The caller's scratch space: their subject, in the chat or project their
 * token names (migration 169) — routed by the acting agent's assignment
 * when an agent is calling, by the person's own otherwise.
 */
export function targetOf(context: MCPToolContext): SandboxTarget | string {
  if (!context.subject) return 'No signed-in identity on this request.';
  return {
    subject: context.subject,
    ...(context.sandboxScope ? { scope: context.sandboxScope } : {}),
    ...(context.agent ? { route: agentRoute(context.agent.agentId) } : {}),
  };
}

export function fileLine(file: WireSandboxFile): string {
  const age = new Date(file.createdAt).toLocaleString();
  return `${file.id} — "${file.filename}" — ${file.sizeBytes} bytes — staged ${age} — expires ${new Date(file.expiresAt).toLocaleString()}`;
}
