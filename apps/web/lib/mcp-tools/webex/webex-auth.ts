/**
 * How webex_* tools reach the WebEx API — injected, not resolved inline.
 *
 * Same shape as `jira-service-management/ops-auth.ts`, and worth naming the
 * one real difference: WebEx has no personal-access-token equivalent to
 * stand in for a sandbox the way Jira's PAT did. A future WebEx test
 * environment will still be OAuth — a stored credential for a sandbox
 * account, refreshed the same way a real user's grant is — not a different
 * auth SCHEME, just a different credential SOURCE behind the identical
 * `WebexAuth` interface. That is really the same fact production already
 * lives with: two different users calling these tools are already two
 * different `oauthWebexAuth` instances, closing over two different grants.
 * Nothing here is test-specific machinery bolted onto production code; it is
 * production's own varying dimension, finally given a name.
 *
 * Until that sandbox exists, `deniedWebexAuth` is the other implementation:
 * every call refused, so `webex.no-sandbox.test.ts` can drive the REAL
 * registered tools and prove every one of them turns a denied credential
 * into a clean errText() rather than a crash — the one thing that IS
 * testable with no sandbox at all.
 *
 * No token is read here (docs/delegate-key-design.md): the caller's grant
 * is an `AuthedFetch` from the delegate, which attaches the credential,
 * refreshes it when due and retries once on a 401. What this module adds
 * is the per-call scope gate and the request/response log line.
 */

import { WEBEX_USER } from '@renkei/provider-grants';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { grantRefusalText, refusalTextOf } from '@/lib/grant-refusals';
import { logger, secure } from '@/lib/logger';
import type { MCPToolContext } from '../common';
import { authFailure } from '../auth-support';

const API = 'https://webexapis.com/v1';
const LABEL = 'WebEx';

export interface WebexAccess {
  /** `fetch` on the caller's own WebEx grant; the delegate supplies the credential. */
  auth: AuthedFetch;
  personEmail: string | null;
}

/**
 * The caller's WebEx grant as a fetcher, plus the address the grant
 * recorded for them. Resolved FRESH on every call: the delegate is asked
 * whether the grant exists (its `describe`, which also yields the
 * personEmail the tools and the bot need), and the fetcher it hands back
 * refreshes on its own. Exported so the summary collectors and the upload
 * executor reuse the same resolution without going through the MCP tool
 * interface at all — they carry only a tenant and a subject, which is
 * all this reads.
 */
export async function resolveWebexAccess(
  context: Pick<MCPToolContext, 'subject'>
): Promise<WebexAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const grant = { provider: WEBEX_USER, subject: context.subject };
  const described = await delegateGrants().describe(grant);
  if (!described.ok) return grantRefusalText(described.err.type, LABEL);
  const personEmail =
    typeof described.val.metadata.personEmail === 'string'
      ? described.val.metadata.personEmail
      : null;
  return { auth: grantFetch(grant), personEmail };
}

export interface WebexAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'denied';
  /**
   * Perform one WebEx API call, after confirming this credential carries
   * `requiredScopes`. Scope checking wraps the network call itself, at every
   * call, not only at tool registration — see JsmOpsAuth's identical note on
   * why that is not redundant with withScopeGate.
   *
   * `path` is relative to https://webexapis.com/v1 — a full URL would put
   * the base back in the handler's hands, the thing this exists to avoid.
   *
   * Every failure — missing scope, no connection, an unresolved grant, or
   * the real API response — comes back as a Response via authFailure() or
   * the genuine fetch result, never a thrown error. See ../auth-support.ts.
   */
  fetch(requiredScopes: readonly string[], path: string, init?: RequestInit): Promise<Response>;
}

function truncateForLog(text: string): string {
  // 1300, not more: secure() bodies encrypt to ~1.4x base64url, and values
  // past ~2KB fall into blob storage where the log viewer does not decrypt
  // on read — 1300 keeps the ciphertext inline, so the viewer shows it.
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/**
 * Production's only implementation: the caller's own WebEx user grant.
 */
export function oauthWebexAuth(context: MCPToolContext): WebexAuth {
  const granted = context.webexScopes;

  return {
    kind: 'oauth',
    async fetch(requiredScopes, path, init) {
      if (granted !== undefined) {
        const missing = requiredScopes.filter((scope) => !granted.includes(scope));
        if (missing.length > 0) {
          return authFailure(
            `This call needs ${missing.join(', ')}, which your WebEx grant does not carry. The ` +
              'org admin selects it on the Integration at developer.webex.com, then you ' +
              'disconnect and reconnect WebEx.',
            403
          );
        }
      }

      const access = await resolveWebexAccess(context);
      if (typeof access === 'string') return authFailure(access, 400);

      const body = init?.body !== undefined ? init.body : undefined;
      const method = init?.method ?? 'GET';
      let response: Response;
      try {
        response = await access.auth(`${API}${path}`, {
          ...init,
          method,
          headers: {
            // A FormData body (a multipart send carrying a file) must NOT
            // get this header — fetch/undici sets its own with the
            // boundary, and overriding it here would send a Content-Type
            // with no boundary and a body WebEx cannot parse.
            ...(body !== undefined && !(body instanceof FormData)
              ? { 'Content-Type': 'application/json' }
              : {}),
            ...init?.headers,
          },
        });
      } catch {
        logger.warn('WebEx API unreachable', {
          component: 'webex/fetch',
          subject: context.subject,
          path,
          method,
        });
        return authFailure('Could not reach webexapis.com');
      }

      // The delegate refusing (grant gone, token unrefreshable, delegate
      // down) is not a WebEx answer; it comes back in the resolvers' words.
      const refused = refusalTextOf(response, LABEL);
      if (refused) return authFailure(refused, 400);

      // The full exchange, scoped to tenant and OIDC user — a status alone
      // is not enough to troubleshoot, and success logs too, because a 2xx
      // that did the wrong thing is invisible without the payloads. Cloned
      // so the caller still gets an unconsumed body.
      const loggedBody = await response
        .clone()
        .text()
        .catch(() => '');
      const logFields = {
        component: 'webex/fetch',
        subject: context.subject,
        path,
        method,
        status: response.status,
        requestBody: typeof body === 'string' ? secure(truncateForLog(body)) : undefined,
        responseBody: loggedBody ? secure(truncateForLog(loggedBody)) : undefined,
      };
      if (response.ok) {
        logger.debug('WebEx API OK response', logFields);
      } else {
        logger.warn('WebEx API non-OK response', logFields);
      }
      return response;
    },
  };
}

/**
 * The other implementation, for when no WebEx sandbox exists to run
 * `oauthWebexAuth` against for real: every call denied, uniformly, so
 * `webex.no-sandbox.test.ts` can prove the tools built on this interface
 * degrade to a clean message instead of a crash. Replace with a real
 * sandbox-backed `oauthWebexAuth` call once a WebEx test account exists —
 * the tools in index.ts would not need to change at all.
 */
export function deniedWebexAuth(): WebexAuth {
  return {
    kind: 'denied',
    async fetch() {
      return authFailure(
        'No WebEx test credential is configured for this connector yet — this call is always ' +
          'denied, on purpose, to prove the tools handle that instead of crashing.',
        401
      );
    },
  };
}
