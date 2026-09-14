/**
 * How a code project is named on the sandbox worker. The worker scopes
 * everything it holds by (tenantId, subject); a code project's checkout
 * and environment belong to the PROJECT, not to whoever is chatting in
 * it, so every member works in one checkout with one environment — and
 * the worker's per-caller isolation (its own uid, its own 0700 directory)
 * becomes per-project isolation. The subject is a tag no person can
 * carry, so it can never collide with a real caller's scratch space.
 */

import type { SandboxTarget } from '@renkei/sandbox-client';

export function codeProjectTarget(tenantId: string, projectId: string): SandboxTarget {
  return { tenantId, subject: `code-project:${projectId}` };
}
