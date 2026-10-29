/**
 * `mcp/prepare` — everything a connect needs to know before the browser is
 * sent to a remote MCP server's authorization server (docs/mcp-connector-
 * design.md). It runs here because the delegate is the one process that
 * dials MCP servers and holds their client secrets:
 *
 *   1. discovery (RFC 9728, RFC 8414): the server's 401 challenge or
 *      well-known document names its authorization server, whose metadata
 *      names the endpoints. Saved on the server's row.
 *   2. registration (RFC 7591): when the server has no client yet and its
 *      authorization server offers dynamic registration, Renkei registers
 *      itself as a public PKCE client where it can, else with a secret that
 *      is sealed on the row. Where there is no registration endpoint the
 *      admin must type a client id, and this says so.
 *
 * An authorization server other than the MCP server's own origin is named by
 * the MCP server, i.e. by a remote party, so its endpoints must be public
 * https addresses. The server's own origin is the admin's registration and
 * is trusted as typed (it may be on a private network).
 */

import type { ServerResponse } from 'node:http';
import { encrypt } from '@renkei/crypto';
import {
  PROTOCOL_VERSION,
  authServerMetadataUrls,
  authorizationServersOf,
  getServer,
  parseAuthServerMetadata,
  protectedResourceMetadataUrls,
  resourceMetadataFromChallenge,
  sameOrigin,
  scopeToRequest,
  updateServer,
  type McpOAuthMetadata,
  type McpServer,
} from '@renkei/connector-mcp';
import { assertPublicHttpsUrl } from '@renkei/connector-sandbox';
import { isRecord, sendJson, str } from '@renkei/worker-kit';
import { silentDelegateLogger, type DelegateLogger } from './grants';

const COMPONENT = 'worker-delegate/mcp';
const TIMEOUT_MS = 15_000;

export type McpPrepareError =
  'bad_request' | 'unknown_server' | 'DISCOVERY_FAILED' | 'NEEDS_CLIENT' | 'REGISTRATION_FAILED';

function statusFor(type: McpPrepareError): number {
  switch (type) {
    case 'bad_request':
      return 400;
    case 'unknown_server':
      return 404;
    case 'NEEDS_CLIENT':
      return 409;
    default:
      return 502;
  }
}

export class McpPreparer {
  constructor(
    private readonly encryptionKey: Buffer,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    /** Tests replace the DNS-resolving guard. */
    private readonly assertPublic: (url: string) => Promise<unknown> = assertPublicHttpsUrl,
    private readonly logger: DelegateLogger = silentDelegateLogger
  ) {}

  async prepare(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const serverId = str(body.serverId);
    const fail = (type: McpPrepareError, message?: string): void => {
      if (statusFor(type) >= 500) {
        this.logger.warn('MCP server {serverId} sign-in preparation failed ({type}): {error}', {
          component: COMPONENT,
          serverId,
          type,
          error: message ?? type,
        });
      }
      sendJson(response, statusFor(type), { error: { type, message } });
    };
    const redirectUri = str(body.redirectUri);
    if (!serverId || !redirectUri) return fail('bad_request', 'serverId and redirectUri');
    const read = await getServer(serverId);
    if (!read.ok || !read.val || !read.val.enabled) return fail('unknown_server');
    let server = read.val;
    if (server.authMode === 'none') return sendJson(response, 200, { authMode: 'none' });

    try {
      if (!server.oauth || body.refresh === true) {
        const found = await this.discover(server);
        if (found === 'open') return sendJson(response, 200, { authMode: 'none', open: true });
        const saved = await updateServer(server.id, { oauth: found });
        if (!saved.ok) return fail('DISCOVERY_FAILED', 'could not save discovery');
        server = saved.val;
      }
      const oauth = server.oauth;
      if (!oauth) return fail('DISCOVERY_FAILED');

      if (!server.clientId) {
        if (!oauth.registrationEndpoint) {
          return fail(
            'NEEDS_CLIENT',
            'This server offers no dynamic client registration. Enter the client ID the server issued for Renkei.'
          );
        }
        const registered = await this.register(server, oauth, redirectUri);
        const saved = await updateServer(server.id, {
          clientId: registered.clientId,
          encryptedClientSecret: registered.secret
            ? encrypt(registered.secret, this.encryptionKey)
            : null,
        });
        if (!saved.ok) return fail('REGISTRATION_FAILED', 'could not save the registration');
        server = saved.val;
      }

      sendJson(response, 200, {
        authMode: 'oauth',
        authorizationEndpoint: oauth.authorizationEndpoint,
        clientId: server.clientId,
        scope: scopeToRequest(server.scopes, oauth),
        resource: server.url,
        supportsPkce: oauth.pkceMethods.length === 0 || oauth.pkceMethods.includes('S256'),
      });
    } catch (error) {
      const type: McpPrepareError =
        error instanceof PrepareFailure ? error.type : 'DISCOVERY_FAILED';
      fail(type, error instanceof Error ? error.message : undefined);
    }
  }

  private async getJson(url: string): Promise<unknown> {
    try {
      const answer = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!answer.ok) return null;
      const parsed: unknown = await answer.json();
      return parsed;
    } catch {
      return null;
    }
  }

  /** The server's own challenge, else null; 'open' when it needs no token. */
  private async probe(server: McpServer): Promise<{ open: boolean; metadataUrl: string | null }> {
    const request =
      server.transport === 'sse'
        ? this.fetchImpl(server.url, {
            headers: { accept: 'text/event-stream' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
        : this.fetchImpl(server.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'mcp-protocol-version': PROTOCOL_VERSION,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'renkei', version: '1.0.0' },
              },
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
    let answer: Response;
    try {
      answer = await request;
    } catch (error) {
      throw new PrepareFailure(
        'DISCOVERY_FAILED',
        `Could not reach the MCP server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const challenge = answer.headers.get('www-authenticate');
    await answer.body?.cancel().catch(() => undefined);
    if (answer.status === 401) {
      return { open: false, metadataUrl: resourceMetadataFromChallenge(challenge) };
    }
    if (answer.ok) return { open: true, metadataUrl: null };
    throw new PrepareFailure('DISCOVERY_FAILED', `The MCP server answered ${answer.status}.`);
  }

  private async discover(server: McpServer): Promise<McpOAuthMetadata | 'open'> {
    const probe = await this.probe(server);
    if (probe.open) return 'open';

    const candidates = [
      ...(probe.metadataUrl ? [probe.metadataUrl] : []),
      ...protectedResourceMetadataUrls(server.url),
    ];
    let issuer: string | null = null;
    for (const url of candidates) {
      const doc = await this.getJson(url);
      const servers = authorizationServersOf(doc);
      if (servers.length > 0) {
        issuer = servers[0];
        break;
      }
    }
    // Older servers are their own authorization server (MCP 2025-03-26).
    issuer ??= new URL(server.url).origin;

    for (const url of authServerMetadataUrls(issuer)) {
      await this.guard(server, url);
      const metadata = parseAuthServerMetadata(await this.getJson(url), issuer);
      if (!metadata) continue;
      for (const endpoint of [
        metadata.authorizationEndpoint,
        metadata.tokenEndpoint,
        metadata.registrationEndpoint,
        metadata.revocationEndpoint,
      ]) {
        if (endpoint) await this.guard(server, endpoint);
      }
      return metadata;
    }
    throw new PrepareFailure(
      'DISCOVERY_FAILED',
      `Could not find the authorization server's metadata at ${issuer}.`
    );
  }

  /** An endpoint off the MCP server's own origin must be a public https address. */
  private async guard(server: McpServer, url: string): Promise<void> {
    if (sameOrigin(server.url, url)) return;
    try {
      await this.assertPublic(url);
    } catch (error) {
      throw new PrepareFailure(
        'DISCOVERY_FAILED',
        `Refusing ${url}: ${error instanceof Error ? error.message : 'not a public https address'}`
      );
    }
  }

  private async register(
    server: McpServer,
    oauth: McpOAuthMetadata,
    redirectUri: string
  ): Promise<{ clientId: string; secret: string | null }> {
    const publicOk = oauth.tokenAuthMethods.length === 0 || oauth.tokenAuthMethods.includes('none');
    const method = publicOk
      ? 'none'
      : oauth.tokenAuthMethods.includes('client_secret_basic')
        ? 'client_secret_basic'
        : 'client_secret_post';
    let answer: Response;
    try {
      answer = await this.fetchImpl(oauth.registrationEndpoint ?? '', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'Renkei',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: method,
          ...(server.scopes ? { scope: server.scopes } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new PrepareFailure(
        'REGISTRATION_FAILED',
        error instanceof Error ? error.message : 'registration failed'
      );
    }
    const json: unknown = await answer.json().catch(() => null);
    if (!answer.ok || !isRecord(json) || typeof json.client_id !== 'string') {
      const detail = isRecord(json) ? str(json.error_description) || str(json.error) : '';
      throw new PrepareFailure(
        'REGISTRATION_FAILED',
        `The authorization server refused Renkei's registration (${answer.status}). ${detail}`.trim()
      );
    }
    return {
      clientId: json.client_id,
      secret:
        typeof json.client_secret === 'string' && json.client_secret ? json.client_secret : null,
    };
  }
}

class PrepareFailure extends Error {
  constructor(
    readonly type: McpPrepareError,
    message: string
  ) {
    super(message);
  }
}
