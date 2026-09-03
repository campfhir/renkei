/**
 * Helpers the sandbox_* and sandbox_browser_* tool modules share: result
 * shaping, the caller's (tenantId, subject) target, and the one-line
 * description of a staged file every stage tool answers with.
 */

import type { MCPToolContext } from '../common';
import type { WireSandboxFile } from '@/lib/sandbox/service-client';

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function errText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function targetOf(context: MCPToolContext): { tenantId: string; subject: string } | string {
  if (!context.subject) return 'No signed-in identity on this request.';
  return { tenantId: context.tenantId, subject: context.subject };
}

export function fileLine(file: WireSandboxFile): string {
  const age = new Date(file.createdAt).toLocaleString();
  return `${file.id} — "${file.filename}" — ${file.sizeBytes} bytes — staged ${age} — expires ${new Date(file.expiresAt).toLocaleString()}`;
}
