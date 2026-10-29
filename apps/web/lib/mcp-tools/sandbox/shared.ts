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

/** The caller's scratch space: their subject, in the chat or project their token names (migration 169). */
export function targetOf(context: MCPToolContext): SandboxTarget | string {
  if (!context.subject) return 'No signed-in identity on this request.';
  return context.sandboxScope
    ? { subject: context.subject, scope: context.sandboxScope }
    : { subject: context.subject };
}

export function fileLine(file: WireSandboxFile): string {
  const age = new Date(file.createdAt).toLocaleString();
  return `${file.id} — "${file.filename}" — ${file.sizeBytes} bytes — staged ${age} — expires ${new Date(file.expiresAt).toLocaleString()}`;
}
