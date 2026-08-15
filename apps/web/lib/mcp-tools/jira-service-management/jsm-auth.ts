/**
 * How the jsm_ tools (classic JSM — service desks, requests, customers;
 * NOT jsm_ops_*, see ops-auth.ts for that) reach Jira — injected, not read
 * off `context.accessToken`/`context.apiBaseUrl` inline.
 *
 * Same full shape as JsmOpsAuth/WebexAuth/ZoomAuth: fetch(requiredScopes,
 * path, init) wraps the scope check around the real call, because
 * `jiraFetch` (../common.ts) already combined "use the caller's credential"
 * and "make the call" into one function, the same as Ops's helper did
 * before conversion. `jiraFetch` throws JiraApiError on any non-2xx
 * response by design (see its own docblock) — so a `Response` this
 * interface hands back with `.ok === false` is ALWAYS this module's own
 * `authFailure()`, never a real Atlassian answer. Every call site added an
 * `if (!response.ok)` check specifically to catch that local-denial path;
 * a real API failure still surfaces by throwing, exactly as it did before
 * this file existed.
 */

import { authFailure } from '../auth-support';
import { jiraFetch } from '../common';
import type { MCPToolContext } from '../common';

export interface JsmAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'pat';
  fetch(requiredScopes: readonly string[], path: string, init?: RequestInit): Promise<Response>;
}

/** Production's only implementation: the caller's own Jira/JSM grant. */
export function oauthJsmAuth(context: MCPToolContext): JsmAuth {
  const granted = context.grantedScopes === undefined ? null : new Set(context.grantedScopes);
  return {
    kind: 'oauth',
    async fetch(requiredScopes, path, init) {
      if (granted) {
        const missing = requiredScopes.filter((scope) => !granted.has(scope));
        if (missing.length > 0) {
          return authFailure(
            `This call needs ${missing.join(', ')}, which this connection's grant does not carry. Reconnect Jira Service Management with that scope enabled.`,
            403
          );
        }
      }
      return jiraFetch(`${context.apiBaseUrl}${path}`, context.accessToken, init);
    },
  };
}

/** Every non-ok Response `fetch()` can return is a local denial — see the header comment. */
export async function describeJsmAuthFailure(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const message =
    typeof body === 'object' && body !== null
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (body as Record<string, unknown>).message
      : undefined;
  return typeof message === 'string' && message ? message : `JSM API answered ${response.status}`;
}

// Granular marker scopes, one per capability bundle in lib/atlassian-scopes.ts
// — bundles travel whole, so a bundle's presence is provable from any one of
// its scopes. Moved here from jira-service-management/index.ts (mirroring
// where opsScopes lives relative to ops.ts) so the SAME functions gate
// registration (via withScopeGate in index.ts) and enforce at call time (via
// JsmAuth.fetch here) — one mapping, not two that could drift apart.
const SD_READ = 'read:request:jira-service-management';
const SD_WRITE = 'write:request:jira-service-management';
const CUSTOMER_READ = 'read:customer:jira-service-management';
const CUSTOMER_WRITE = 'write:customer:jira-service-management';

export function serviceDeskScopes(_toolName: string, readOnly: boolean): string[] {
  return readOnly ? [SD_READ] : [SD_READ, SD_WRITE];
}

export function customerScopes(_toolName: string, readOnly: boolean): string[] {
  return readOnly ? [CUSTOMER_READ] : [CUSTOMER_READ, CUSTOMER_WRITE];
}
