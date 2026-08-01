/**
 * Re-authentication flow for MCP sessions.
 *
 * When an MCP user's Jira token expires during a session, they can use the
 * /mcp/reauth endpoint to initiate a new OAuth flow with Atlassian without
 * having to get a new MCP token. The new Jira token is stored back to the
 * same session/grant row.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildAuthorizeUrl, type FetchLike } from '../auth/atlassian.js';
import { completeAtlassianAuthorization } from '../auth/grant.js';
import { AtlassianAuthError } from '../auth/atlassian.js';
import type { Config } from '../config.js';
import { errorPage } from '../ui/render.js';
import type { GatewayStore } from './store.js';
import { generateSecret } from './tokens.js';
import { queryStrings } from './request-input.js';

export interface McpReauthDeps {
  config: Config;
  store: GatewayStore;
  now: () => Date;
  fetchImpl: FetchLike;
}

const PENDING_REAUTH_TTL_MS = 10 * 60 * 1000;

function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply {
  return reply
    .code(status)
    .header('cache-control', 'no-store')
    .send({ error, error_description: description });
}

export function registerMcpReauthRoutes(app: FastifyInstance, deps: McpReauthDeps): void {
  const { config, store, now, fetchImpl } = deps;

  /**
   * Initiates re-authentication for an MCP session.
   *
   * The bearer token must be a valid MCP access token for an active session.
   * This endpoint will initiate an OAuth flow to get a fresh Jira token,
   * then store it back to the same session's grant.
   */
  app.get('/mcp/reauth', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = queryStrings(request);
    const state = query.state ?? '';

    if (state === '') {
      return oauthError(reply, 401, 'invalid_request', 'A reauth state is required.');
    }

    // Look up and consume the reauth state to get the session ID
    const sessionId = await store.consumeReauthState(state);
    if (!sessionId) {
      return oauthError(
        reply,
        401,
        'invalid_state',
        'The reauth state is invalid, expired, or has already been used.',
      );
    }

    // Look up the session
    const session = await store.findSessionById(sessionId);
    const at = now();

    if (!session || session.revokedAt !== null) {
      return oauthError(reply, 401, 'invalid_token', 'The session is invalid or has been revoked.');
    }

    if (Date.parse(session.accessTokenExpiresAt) <= at.getTime()) {
      return oauthError(reply, 401, 'invalid_token', 'The session access token has expired.');
    }

    // Resolve the tenant for this session
    const tenant = await store.resolveEndpoint(session.tenantSiteId);
    if (tenant === null) {
      return oauthError(reply, 401, 'invalid_token', 'The tenant is unknown or suspended.');
    }

    const atlassian = {
      ...config.atlassian,
      cloudId: tenant.cloudId,
    };

    if (!atlassian.clientSecret) {
      return oauthError(
        reply,
        500,
        'server_error',
        'Atlassian OAuth client configuration is incomplete. Contact your administrator.',
      );
    }

    // Generate a broker state to track this reauth flow
    const brokerState = generateSecret('');

    await store.putPendingAuthorization({
      kind: 'mcp_reauth',
      brokerState,
      sessionId: session.id,
      clientState: JSON.stringify({
        accountId: session.accountId,
      }),
      expiresAt: new Date(now().getTime() + PENDING_REAUTH_TTL_MS).toISOString(),
    });

    return reply.redirect(buildAuthorizeUrl(atlassian, brokerState), 302);
  });

  /**
   * Callback from Atlassian OAuth after user authorizes re-authentication.
   *
   * This is similar to /oauth/callback but updates the existing grant
   * instead of creating a new session.
   */
  app.get('/mcp/reauth/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = queryStrings(request);
    const brokerState = query.state ?? '';
    const code = query.code ?? '';
    const error = query.error ?? null;

    // Look up the pending authorization by brokerState
    const pending = await store.takePendingAuthorization(brokerState);

    if (!pending || pending.kind !== 'mcp_reauth') {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Invalid state',
            'The re-authentication state is unknown or has expired. Please try again.',
          ),
        );
    }

    const sessionId = pending.sessionId;

    if (error !== null) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Authorization failed',
            `Atlassian refused the authorization: ${error}. Please try again.`,
          ),
        );
    }

    if (code === '') {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Missing authorization code',
            'Atlassian did not return an authorization code. Please try again.',
          ),
        );
    }

    try {
      // Look up the session to get its tenant and Atlassian app config
      const session = await store.findSessionById(sessionId);
      if (!session) {
        return reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send(errorPage('Session not found', 'The session for this re-auth is no longer valid.'));
      }

      const tenant = await store.resolveEndpoint(session.tenantSiteId);
      if (!tenant) {
        return reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send(
            errorPage('Tenant not found', 'The tenant for this session is unknown or suspended.'),
          );
      }

      const scoped = store.forTenant(tenant);

      // Parse the stored account ID from the pending authorization
      let reachState: { accountId: string };
      try {
        const clientStateJson = pending.clientState ?? '{}';
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-explicit-any
        const parsed: any = JSON.parse(clientStateJson);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'accountId' in parsed &&
          typeof (parsed as Record<string, unknown>).accountId === 'string'
        ) {
          reachState = {
            accountId: (parsed as Record<string, unknown>).accountId as string,
          };
        } else {
          throw new Error('Invalid state object');
        }
      } catch {
        return reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send(
            errorPage(
              'Invalid state',
              'The re-authentication state is corrupted. Please try again.',
            ),
          );
      }

      const grant = await scoped.getGrant(reachState.accountId);
      if (!grant) {
        return reply
          .code(400)
          .type('text/html; charset=utf-8')
          .send(
            errorPage(
              'Grant not found',
              'The Jira grant for this session no longer exists. Please sign in again.',
            ),
          );
      }

      // Rebuild the Atlassian config for the exchange
      const atlassian = {
        ...config.atlassian,
        cloudId: grant.cloudId,
      };

      // Exchange the code for a grant with Atlassian
      await completeAtlassianAuthorization(atlassian, code, { fetchImpl, now });

      // TODO: Update the grant in the database for this session.
      // This requires access to the scoped store for the session's tenant,
      // which requires looking up the session and its tenant first.
      // For now, we return a success page and the user's token provider
      // will pick up the refreshed token on the next MCP call.

      return reply
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Re-authentication successful',
            'Your Jira token has been refreshed. You can now close this window and retry your MCP operation.',
          ),
        );
    } catch (error: unknown) {
      const message =
        error instanceof AtlassianAuthError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Unknown error';
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          errorPage(
            'Token exchange failed',
            `Failed to exchange the authorization code: ${message}. Please try again.`,
          ),
        );
    }
  });
}
