/**
 * How the confluence_ tools reach Confluence Cloud — injected, not resolved
 * inline. Same narrow shape as GraphAuth (see graph/graph-auth.ts), for the
 * same reason: confluenceGet/confluencePost/confluencePut/confluenceDelete/
 * confluenceUpload (client.ts) already take an `access: ConfluenceAccess`
 * parameter separate from resolving one, so the only thing that needs to
 * become swappable is resolveConfluenceAccess itself. Unlike Ops/WebEx/Zoom,
 * there is no fetch(requiredScopes, path, init) to wrap here — call-time
 * scope enforcement for Confluence stays at registration only, via
 * confluenceScopeFor + withScopeGate in index.ts, same as it already was.
 *
 * Confluence DOES have a real sandbox (unlike WebEx/Zoom/Graph): a personal
 * Atlassian API token authenticates cleanly via Basic auth against both the
 * bare `/wiki/api/v2/...` path and the `api.atlassian.com/ex/confluence/
 * {cloudId}/wiki/...` gateway path (verified directly against the sandbox —
 * no Ops-style gateway-vs-bare-base trap here). See
 * ../test-support/atlassian-sandbox.ts for the PAT implementation.
 */

import { resolveConfluenceAccess, type ConfluenceAccess } from './client';
import type { MCPToolContext } from '../common';

export interface ConfluenceAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'pat';
  /**
   * Resolve the credential for one call. Returns the same ConfluenceAccess |
   * string union resolveConfluenceAccess always returned — a human-readable
   * denial string, not a thrown error — so every call site's existing
   * `if (typeof access === 'string') return errText(access)` needs no
   * change beyond calling auth.resolve() instead of the free function
   * directly.
   */
  resolve(): Promise<ConfluenceAccess | string>;
}

/** Production's only implementation: the caller's own Confluence grant. */
export function oauthConfluenceAuth(context: MCPToolContext): ConfluenceAuth {
  return {
    kind: 'oauth',
    resolve: () => resolveConfluenceAccess(context),
  };
}
