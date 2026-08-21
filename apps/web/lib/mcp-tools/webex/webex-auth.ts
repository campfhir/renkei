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
 */

import {
  getGrant,
  refreshGrantTokens,
  WEBEX_USER,
  WebexUserAdapter,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import { getWebexUserApp } from '@/lib/webex-app';
import { logger, secure } from '@/lib/logger';
import type { MCPToolContext } from '../common';
import { authFailure } from '../auth-support';

const API = 'https://webexapis.com/v1';
/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface WebexAccess {
  accessToken: string;
  personEmail: string | null;
}

/**
 * The caller's live WebEx token, refreshed through the adapter when stale.
 *
 * Resolved FRESH on every call rather than once when the auth object is
 * constructed (registration time) — tokens rotate on refresh, and WebEx's
 * tool volume is low enough that this codebase deliberately skips a
 * module-level token cache the way Jira's jiraFetch keeps one (see that
 * function's own comment). Exported so the summary collectors can reuse the
 * same refresh-aware resolution without going through the MCP tool
 * interface at all.
 */
export async function resolveWebexAccess(context: MCPToolContext): Promise<WebexAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Server misconfigured (encryption key).';
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', context.tenantId)
    .where('provider', '=', WEBEX_USER)
    .where('subject', '=', context.subject)
    .executeTakeFirst();
  if (!row) {
    return 'WebEx is not connected. Connect it on the Connectors page, then try again.';
  }

  const grantResult = await getGrant(
    WEBEX_USER,
    context.tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) return 'Could not read the WebEx grant.';
  let grant: ProviderGrant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app = await getWebexUserApp(context.tenantId, context.origin ?? '');
    if (!app) return 'WebEx user integration is no longer configured.';
    const refreshed = await refreshGrantTokens(
      new WebexUserAdapter(app.clientSecret),
      context.tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? 'Your WebEx authorization was revoked. Reconnect it on the Connectors page.'
        : 'Could not refresh the WebEx token; try again shortly.';
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const personEmail =
    typeof grant.metadata.personEmail === 'string' ? grant.metadata.personEmail : null;
  return { accessToken: grant.accessToken, personEmail };
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
        response = await fetch(`${API}${path}`, {
          ...init,
          method,
          headers: {
            Authorization: `Bearer ${access.accessToken}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...init?.headers,
          },
        });
      } catch {
        logger.warn('WebEx API unreachable', {
          component: 'webex/fetch',
          tenantId: context.tenantId,
          subject: context.subject,
          path,
          method,
        });
        return authFailure('Could not reach webexapis.com');
      }

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
        tenantId: context.tenantId,
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
