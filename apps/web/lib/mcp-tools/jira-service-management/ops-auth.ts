/**
 * How jsm_ops_* tools reach the JSM Operations API — injected, not branched
 * on.
 *
 * Before this existed, ops.ts read `context.accessToken` and a hardcoded
 * `opsBase()` directly, and there was exactly one way to call it: a real
 * OAuth grant. Proving the rotation-id fix (see ops.integration.test.ts)
 * against a real sandbox needed a SECOND way — a personal API token, since a
 * test script cannot complete an interactive 3LO consent flow — and the only
 * place left to put that was outside production code entirely: a
 * `jest.mock('../common', …)` that swapped the transport after the fact, and
 * a raw URL rewrite bolted on top of it because the Ops API's OAuth gateway
 * (`/ex/jira/{cloudId}/jsm/ops/...`, what `opsBase()` always built) accepts
 * only a Bearer token, while a personal token only works against the OTHER
 * base (`/jsm/ops/api/{cloudId}/...`). Two mechanisms, two different URLs,
 * and the choice was hardcoded to the one production uses — so the test had
 * to reach around the tool code rather than configure it.
 *
 * JsmOpsAuth is that choice made an explicit, swappable dependency instead.
 * `oauthJsmOpsAuth` (below) is what production always uses.
 * `test-support/atlassian-sandbox.ts`'s `patJsmOpsAuth` is what
 * `*.integration.test.ts` uses instead — same interface, same tool code in
 * ops.ts, no test-only rewriting of what the code under test actually built.
 */

import { jiraFetch } from '../common';
import type { MCPToolContext } from '../common';

export interface JsmOpsAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'pat';
  /**
   * Null when ready to make calls; otherwise the message a handler should
   * return via errText() without ever reaching the network. A LOCAL
   * precondition (no cloud id on this connection) — never something
   * Atlassian answered — so it stays a separate check rather than folding
   * into fetch()'s Response-shaped failures, which would misdescribe it as
   * a reply from the API.
   */
  unavailableReason(): string | null;
  /**
   * Perform one Ops API call, after confirming this credential carries
   * `requiredScopes`.
   *
   * Scope checking happens HERE — wrapping the actual network call — rather
   * than as a separate step a handler calls (and could forget to), and
   * rather than living ONLY at tool registration. capability-gate.ts's
   * withScopeGate decides whether a tool is OFFERED at all, at registration
   * time; this decides whether the credential making THIS call still
   * carries what it needs, at call time, so it isn't just an optimization —
   * a caller that builds its own McpServer stub and never wraps it in
   * withScopeGate (every test in this file's suite does exactly that) gets
   * no scope enforcement at all otherwise.
   *
   * `path` is relative to the auth's own base — `/schedules?expand=rotation`,
   * never a full URL — because which base that resolves against is exactly
   * what differs between implementations; a handler that built the full URL
   * itself would be back to hardcoding one mechanism.
   *
   * On a missing scope this returns a synthetic Response describing what's
   * missing, rather than throwing — every call site's existing
   * `if (!response.ok) return errText(await describeOpsFailure(response))`
   * handles it with no special case.
   */
  fetch(requiredScopes: readonly string[], path: string, init?: RequestInit): Promise<Response>;
}

function scopeDeniedResponse(missing: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      message:
        `This call needs ${missing.join(', ')}, which your Atlassian grant does not carry. ` +
        'An org admin adds the missing scope(s) to the Jira Service Management Atlassian app ' +
        'in connector setup, then you reconnect.',
    }),
    { status: 403 }
  );
}

/**
 * Production's only implementation: the caller's real OAuth grant, through
 * the gateway every other 3LO call in this codebase uses.
 */
export function oauthJsmOpsAuth(context: MCPToolContext): JsmOpsAuth {
  const base = context.cloudId
    ? `https://api.atlassian.com/ex/jira/${context.cloudId}/jsm/ops/api/v1`
    : null;
  // undefined = a grant recorded before scopes were, which registers (and
  // therefore must run) EVERY tool — see withScopeGate. null here means the
  // same: skip the check rather than deny a caller with nothing recorded to
  // check against.
  const granted = context.grantedScopes === undefined ? null : new Set(context.grantedScopes);

  return {
    kind: 'oauth',
    unavailableReason: () => (base ? null : 'No Atlassian cloud id on this connection.'),
    async fetch(requiredScopes, path, init) {
      if (!base) {
        return new Response(
          JSON.stringify({ message: 'No Atlassian cloud id on this connection.' }),
          { status: 400 }
        );
      }
      if (granted) {
        const missing = requiredScopes.filter((scope) => !granted.has(scope));
        if (missing.length > 0) return scopeDeniedResponse(missing);
      }
      return jiraFetch(`${base}${path}`, context.accessToken, init);
    },
  };
}

/**
 * Granular marker scopes, one per capability bundle in
 * lib/atlassian-scopes.ts — bundles travel whole, so a bundle's presence is
 * provable from any one of its scopes. Exported so index.ts's registration
 * gate and this module's own call-time gate check the identical set; two
 * copies of this mapping is how the two would eventually disagree about what
 * a tool needs.
 */
export const OPS_ALERT_READ = 'read:ops-alert:jira-service-management';
export const OPS_ALERT_WRITE = 'write:ops-alert:jira-service-management';
export const OPS_CONFIG_READ = 'read:ops-config:jira-service-management';
export const OPS_CONFIG_WRITE = 'write:ops-config:jira-service-management';
export const OPS_CONFIG_DELETE = 'delete:ops-config:jira-service-management';

/**
 * The ops module spans three scope families: alerts, config, and config
 * deletion. Resolved by tool name, which the module's naming keeps honest.
 */
export function opsScopes(toolName: string, readOnly: boolean): string[] {
  if (toolName.includes('alert')) {
    return readOnly ? [OPS_ALERT_READ] : [OPS_ALERT_READ, OPS_ALERT_WRITE];
  }
  if (toolName === 'jsm_ops_delete_override') return [OPS_CONFIG_READ, OPS_CONFIG_DELETE];
  return readOnly ? [OPS_CONFIG_READ] : [OPS_CONFIG_READ, OPS_CONFIG_WRITE];
}
