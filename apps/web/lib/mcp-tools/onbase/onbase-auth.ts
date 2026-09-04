/**
 * How onbase_* and onbase_admin_* tools reach the customer's two Hyland
 * connectors — injected, not resolved inline, following the ZoomAuth/
 * GraphAuth shape with two departures worth stating:
 *
 *   - There is no requiredScopes parameter. Each Hyland IdP client exposes
 *     one opaque API scope, so per-tool scope gating would always pass or
 *     always fail — the availability probe (a grant row exists) is the
 *     whole gate.
 *   - No HTTP leaves this process. Every request rides the OnBase worker
 *     (the API server usually lives on a private network), so `fetch`
 *     wraps the worker's `api` op and `content` wraps its byte op.
 *
 * `onbase` (Document Management API) and `onbase-admin` (Administration
 * API) are separate Hyland OAuth clients with separate grants — mirroring
 * Jira/JSM/Confluence/Bitbucket as four separate Atlassian connectors
 * (connector-atlassian) rather than one. The logic below (token refresh,
 * the once-refresh-once-retry-on-401 dance, the OnBaseAuth shape) is
 * identical between them, so `connectorAuth()` builds it once per spec
 * instead of twice; only the grant provider, the worker's `connector`
 * field, and the adapter class differ.
 *
 * Session-lifecycle defensiveness: Hyland's docs reference server-side
 * session behavior whose guide we do not have, so a 401 from either API is
 * treated as "token expired however that happened" — one forced refresh
 * and a single retry, then the failure surfaces.
 */

import {
  getGrant,
  refreshGrantTokens,
  ONBASE,
  ONBASE_ADMIN,
  OnBaseAdapter,
  OnBaseAdminAdapter,
  type OnBaseRefresh,
  type ProviderAdapter,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { ok, err } from '@campfhir/safe-functions/helpers';
import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import {
  obApi,
  obContent,
  obRefreshToken,
  onbaseClientFailure,
  type OnBaseClientResult,
  type WireApiResponse,
  type WireContentResponse,
} from '@/lib/onbase/service-client';
import { logger } from '@/lib/logger';
import type { MCPToolContext } from '../common';

/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface OnBaseAccess {
  accessToken: string;
  accountId: string;
}

export interface OnBaseApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  accept?: string;
}

export interface OnBaseAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'denied';
  /**
   * One API request via the worker, against this auth's own connector. A
   * string result is the user-visible refusal (the fileshare-auth idiom);
   * otherwise the envelope carries the upstream status and raw body text.
   */
  api(request: OnBaseApiRequest): Promise<WireApiResponse | string>;
  /** Rendition bytes via the worker, within the org's transfer cap. */
  content(path: string, accept?: string): Promise<WireContentResponse | string>;
  /** The caller's live token, for the upload path that streams bytes. */
  access(): Promise<OnBaseAccess | string>;
}

/** What distinguishes the two connectors; everything else below is shared. */
interface OnBaseConnectorSpec {
  /** provider_grants.provider AND the worker's `connector` field — same string. */
  connector: string;
  /** For refusal prose: "OnBase" or "OnBase Administration". */
  label: string;
  adapter: (refresh: OnBaseRefresh) => ProviderAdapter;
}

function failureText(error: Parameters<typeof onbaseClientFailure>[0]): string {
  return onbaseClientFailure(error).message;
}

/**
 * The caller's live token for one connector, refreshed through the
 * worker-backed adapter when stale (or when `forceRefresh` — the 401 retry
 * path). Resolved FRESH on every call, the same no-module-cache rule as
 * every other connector.
 */
function makeResolveAccess(spec: OnBaseConnectorSpec) {
  return async function resolveAccess(
    // A structural subset of MCPToolContext, so the upload executor (which
    // has only a slot row) resolves the same way the tools do.
    context: { tenantId: string; subject?: string | null },
    options?: { forceRefresh?: boolean }
  ): Promise<OnBaseAccess | string> {
    if (!context.subject) return 'No signed-in subject on this MCP session.';
    const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (!keyResult.ok) return 'Server misconfigured (encryption key).';
    const dbResult = getDatabase();
    if (!dbResult.ok) return 'Database unavailable.';

    const row = await dbResult.val
      .selectFrom('provider_grants')
      .select('provider_account_id')
      .where('tenant_id', '=', context.tenantId)
      .where('provider', '=', spec.connector)
      .where('subject', '=', context.subject)
      .executeTakeFirst();
    if (!row) {
      return `${spec.label} is not connected. Connect it on the Connectors page, then try again.`;
    }

    const grantResult = await getGrant(
      spec.connector,
      context.tenantId,
      row.provider_account_id,
      keyResult.val
    );
    if (!grantResult.ok || !grantResult.val) return `Could not read the ${spec.label} grant.`;
    let grant: ProviderGrant = grantResult.val;

    const stale = new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS;
    if (stale || options?.forceRefresh) {
      if (!grant.refreshToken) {
        return (
          `Your ${spec.label} session has expired and the IdP issued no refresh token. Reconnect ` +
          `${spec.label} on the Connectors page (and ask the admin to allow offline_access on the ` +
          'Renkei client).'
        );
      }
      const adapter = spec.adapter(async (refreshToken) => {
        const refreshed = await obRefreshToken({
          tenantId: context.tenantId,
          connector: spec.connector,
          refreshToken,
        });
        if (!refreshed.ok) {
          // Only the IdP's explicit invalid_grant verdict may kill the grant.
          if (refreshed.err.kind === 'op' && refreshed.err.type === 'invalid_grant') {
            return err('GRANT_REVOKED' as const);
          }
          return err('REFRESH_FAILED' as const, {
            message: onbaseClientFailure(refreshed.err).message,
          });
        }
        const tokens = refreshed.val;
        return ok({
          accessToken: tokens.access_token,
          refreshToken:
            typeof tokens.refresh_token === 'string' && tokens.refresh_token
              ? tokens.refresh_token
              : refreshToken,
          expiresAt: new Date(
            Date.now() + (typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600) * 1000
          ),
        });
      });
      const refreshed = await refreshGrantTokens(
        adapter,
        context.tenantId,
        grant.accountId,
        keyResult.val,
        logger
      );
      if (!refreshed.ok) {
        return refreshed.err.type === 'GRANT_REVOKED'
          ? `Your ${spec.label} authorization was revoked. Reconnect it on the Connectors page.`
          : `Could not refresh the ${spec.label} token; try again shortly.`;
      }
      grant = { ...grant, accessToken: refreshed.val.accessToken };
    }

    return { accessToken: grant.accessToken, accountId: grant.accountId };
  };
}

function makeOauthAuth(
  spec: OnBaseConnectorSpec,
  resolveAccess: ReturnType<typeof makeResolveAccess>
) {
  return function oauthAuth(context: MCPToolContext): OnBaseAuth {
    async function withRetry<T>(
      call: (accessToken: string) => Promise<OnBaseClientResult<T>>,
      statusOf: (value: T) => number | null
    ): Promise<T | string> {
      const access = await resolveAccess(context);
      if (typeof access === 'string') return access;

      const first = await call(access.accessToken);
      if (first.ok && statusOf(first.val) !== 401) return first.val;
      const firstWas401 =
        (first.ok && statusOf(first.val) === 401) ||
        (!first.ok && first.err.kind === 'op' && first.err.status === 401);
      if (!firstWas401) {
        return first.ok ? first.val : failureText(first.err);
      }

      // A 401 with a token we believed valid: the API Server's session may
      // have died independently of the token's lifetime (the undocumented
      // lifecycle) — refresh once and retry once, then surface.
      const fresh = await resolveAccess(context, { forceRefresh: true });
      if (typeof fresh === 'string') return fresh;
      const second = await call(fresh.accessToken);
      if (!second.ok) return failureText(second.err);
      return second.val;
    }

    return {
      kind: 'oauth',
      api(request) {
        return withRetry(
          (accessToken) =>
            obApi({
              tenantId: context.tenantId,
              connector: spec.connector,
              ...(context.subject ? { subject: context.subject } : {}),
              accessToken,
              method: request.method,
              path: request.path,
              ...(request.query ? { query: request.query } : {}),
              ...(request.body !== undefined ? { body: request.body } : {}),
              ...(request.accept ? { accept: request.accept } : {}),
            }),
          (value) => value.status
        );
      },
      content(path, accept) {
        return withRetry(
          (accessToken) =>
            obContent({
              tenantId: context.tenantId,
              connector: spec.connector,
              ...(context.subject ? { subject: context.subject } : {}),
              accessToken,
              path,
              ...(accept ? { accept } : {}),
            }),
          () => null
        );
      },
      access() {
        return resolveAccess(context);
      },
    };
  };
}

/**
 * The other implementation, for when no OnBase instance exists to run the
 * oauth one against for real. See webex-auth.ts's `deniedWebexAuth` for the
 * full reasoning — identical here.
 */
function makeDeniedAuth(spec: OnBaseConnectorSpec) {
  return function deniedAuth(): OnBaseAuth {
    const refusal =
      `No ${spec.label} test credential is configured for this connector yet — this call is ` +
      'always denied, on purpose, to prove the tools handle that instead of crashing.';
    return {
      kind: 'denied',
      api: () => Promise.resolve(refusal),
      content: () => Promise.resolve(refusal),
      access: () => Promise.resolve(refusal),
    };
  };
}

/* ---------------------------- Document API ---------------------------- */

const DOCUMENT_SPEC: OnBaseConnectorSpec = {
  connector: ONBASE,
  label: 'OnBase',
  adapter: (refresh) => new OnBaseAdapter(refresh),
};

export const resolveOnBaseAccess = makeResolveAccess(DOCUMENT_SPEC);
export const oauthOnbaseAuth = makeOauthAuth(DOCUMENT_SPEC, resolveOnBaseAccess);
export const deniedOnbaseAuth = makeDeniedAuth(DOCUMENT_SPEC);

/* -------------------------- Administration API -------------------------- */

const ADMIN_SPEC: OnBaseConnectorSpec = {
  connector: ONBASE_ADMIN,
  label: 'OnBase Administration',
  adapter: (refresh) => new OnBaseAdminAdapter(refresh),
};

export const resolveOnBaseAdminAccess = makeResolveAccess(ADMIN_SPEC);
export const oauthOnbaseAdminAuth = makeOauthAuth(ADMIN_SPEC, resolveOnBaseAdminAccess);
export const deniedOnbaseAdminAuth = makeDeniedAuth(ADMIN_SPEC);
