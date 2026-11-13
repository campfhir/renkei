/**
 * Which scope a sandbox is for, read from the key callers already route
 * by (packages/sandbox-client routing.ts): a person's subject for their
 * chats, `agent:<id>` for an agent's runs, `code-project:<id>` and
 * `chat-project:<id>` for a project, and `system` for the calls made for
 * no caller at all (an organization's image rules, a capability check).
 * One sandbox per key; the kind is only what the key says about itself,
 * for the row, the machine's labels and the logs.
 */

import type { SandboxKind } from '@renkei/db';

/** The scope of calls made for no caller. */
export const SYSTEM_ROUTE_KEY = 'system';

const MAX_ROUTE_KEY_LENGTH = 512;

/** A key a sandbox can be made for: something printable, of a sane length. */
export function isRouteKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ROUTE_KEY_LENGTH) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function sandboxKindOf(routeKey: string): SandboxKind {
  if (routeKey === SYSTEM_ROUTE_KEY) return 'system';
  if (routeKey.startsWith('agent:')) return 'agent';
  if (routeKey.startsWith('code-project:') || routeKey.startsWith('chat-project:')) {
    return 'project';
  }
  return 'user';
}
