/**
 * How zoom_* tools reach the Zoom API — injected, not resolved inline.
 *
 * Same shape and same reasoning as webex/webex-auth.ts: no personal-token
 * equivalent exists for Zoom either, so the eventual sandbox implementation
 * will still be `oauthZoomAuth`-shaped, just closing over a stored sandbox
 * credential instead of a live per-request grant lookup. `deniedZoomAuth` is
 * the stand-in until that credential exists — see zoom.no-sandbox.test.ts.
 *
 * One limitation this file does NOT paper over: zoom_get_transcript and
 * zoom_get_meeting_summary construct a `ZoomClient` from
 * @renkei/connector-zoom directly, and that client makes its own HTTP calls
 * with no injectable transport. Rather than invent a workaround (routing a
 * real network client through a Response-returning interface, or extending
 * ZoomAuth with a raw-token escape hatch that every OTHER connector's
 * interface would then need too, for consistency), those two tools resolve
 * access via `resolveZoomAccess` directly, same as every tool here did
 * before this refactor — see index.ts. That is a pre-existing limitation of
 * ZoomClient's own design, not something introduced here, and not something
 * fixable without changing that shared package.
 */

import {
  getGrant,
  refreshGrantTokens,
  ZOOM,
  ZoomAdapter,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import { getZoomApp } from '@/lib/zoom-app';
import { logger, secure } from '@/lib/logger';
import type { MCPToolContext } from '../common';
import { authFailure } from '../auth-support';

/** Exported so index.ts's two ZoomClient-based tools can share it — see this file's header. */
export const ZOOM_API_BASE = 'https://api.zoom.us/v2';
const API = ZOOM_API_BASE;
/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface ZoomAccess {
  accessToken: string;
  email: string | null;
}

/**
 * The caller's live Zoom token, refreshed through the adapter when stale.
 * Resolved FRESH on every call — see WebEx's identical note on why no
 * module-level token cache exists here. Exported for the summary collectors
 * AND for the two ZoomClient-based tools in index.ts that cannot go through
 * ZoomAuth.fetch() at all (see this file's header).
 */
export async function resolveZoomAccess(context: MCPToolContext): Promise<ZoomAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Server misconfigured (encryption key).';
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', context.tenantId)
    .where('provider', '=', ZOOM)
    .where('subject', '=', context.subject)
    .executeTakeFirst();
  if (!row) {
    return 'Zoom is not connected. Connect it on the Connectors page, then try again.';
  }

  const grantResult = await getGrant(
    ZOOM,
    context.tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) return 'Could not read the Zoom grant.';
  let grant: ProviderGrant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app = await getZoomApp(context.tenantId, context.origin ?? '');
    if (!app) return 'Zoom integration is no longer configured.';
    const refreshed = await refreshGrantTokens(
      new ZoomAdapter(app.clientSecret),
      context.tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? 'Your Zoom authorization was revoked. Reconnect it on the Connectors page.'
        : 'Could not refresh the Zoom token; try again shortly.';
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const email = typeof grant.metadata.email === 'string' ? grant.metadata.email : null;
  return { accessToken: grant.accessToken, email };
}

export interface ZoomAuth {
  /** For log/error context — which mechanism actually made the call. */
  readonly kind: 'oauth' | 'denied';
  /**
   * Perform one Zoom API call, after confirming this credential carries
   * `requiredScopes`. Same wrapping-the-call reasoning as every other
   * XAuth in this codebase — see JsmOpsAuth's fuller note.
   *
   * `path` is relative to https://api.zoom.us/v2.
   */
  fetch(requiredScopes: readonly string[], path: string, init?: RequestInit): Promise<Response>;
}

function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/** Production's only implementation: the caller's own Zoom user grant. */
export function oauthZoomAuth(context: MCPToolContext): ZoomAuth {
  // Scope nuance unique to Zoom: a classic-scope Marketplace app ignores the
  // authorize request's scope parameter and mints its full scope set, so
  // context.zoomScopes already arrives as requested ∩ granted — computed by
  // the OAuth callback route, not here. See index.ts's original header.
  const granted = context.zoomScopes;

  return {
    kind: 'oauth',
    async fetch(requiredScopes, path, init) {
      if (granted !== undefined) {
        const missing = requiredScopes.filter((scope) => !granted.includes(scope));
        if (missing.length > 0) {
          return authFailure(
            `This call needs ${missing.join(', ')}, which your Zoom grant does not carry. The ` +
              'org admin adds it to the Marketplace app, then you disconnect and reconnect Zoom.',
            403
          );
        }
      }

      const access = await resolveZoomAccess(context);
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
        logger.warn('Zoom API unreachable', {
          component: 'zoom/fetch',
          tenantId: context.tenantId,
          subject: context.subject,
          path,
          method,
        });
        return authFailure('Could not reach api.zoom.us');
      }

      if (!response.ok) {
        const responseBody = await response
          .clone()
          .text()
          .catch(() => '');
        logger.warn('Zoom API non-OK response', {
          component: 'zoom/fetch',
          tenantId: context.tenantId,
          subject: context.subject,
          path,
          method,
          status: response.status,
          requestBody: typeof body === 'string' ? secure(truncateForLog(body)) : undefined,
          responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
        });
      }
      return response;
    },
  };
}

/**
 * The other implementation, for when no Zoom sandbox exists to run
 * `oauthZoomAuth` against for real. See webex-auth.ts's `deniedWebexAuth`
 * for the full reasoning — identical here.
 */
export function deniedZoomAuth(): ZoomAuth {
  return {
    kind: 'denied',
    async fetch() {
      return authFailure(
        'No Zoom test credential is configured for this connector yet — this call is always ' +
          'denied, on purpose, to prove the tools handle that instead of crashing.',
        401
      );
    },
  };
}
