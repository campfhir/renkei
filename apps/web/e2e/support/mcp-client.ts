/**
 * An MCP client of the app's own OAuth server, the way one registers and
 * asks (app/api/mcp/oauth/*): dynamic client registration, then an
 * authorize URL with an S256 PKCE challenge, then — once the person has
 * allowed it on the consent page — the code exchanged for an access and a
 * refresh token.
 *
 * Registration is open only while the org's `enableDcr` setting is on
 * (off by default). The setting is organization-wide, so `registerClient`
 * turns it on only for the registration and back off again if it found it
 * off; a concurrent test that turned it off in between is answered by
 * turning it on and trying again.
 */

import { createHash, randomBytes } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { MEMORY_BASE_URL } from '../constants';
import type { Person } from './person';

export interface McpClient {
  clientName: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

type Headers = Record<string, string>;

async function dcrEnabled(request: APIRequestContext, headers: Headers): Promise<boolean> {
  const response = await request.get(`${MEMORY_BASE_URL}/api/admin/org-settings`, { headers });
  expect(response.ok(), `GET org-settings: ${await response.text()}`).toBe(true);
  const body: unknown = await response.json();
  const settings =
    typeof body === 'object' && body !== null && 'settings' in body ? body.settings : null;
  return typeof settings === 'object' && settings !== null && 'enableDcr' in settings
    ? settings.enableDcr === true
    : false;
}

async function setDcr(request: APIRequestContext, headers: Headers, on: boolean): Promise<void> {
  const response = await request.put(`${MEMORY_BASE_URL}/api/admin/org-settings`, {
    headers,
    data: { enableDcr: on },
  });
  expect(response.ok(), `PUT enableDcr: ${await response.text()}`).toBe(true);
}

/** Register a client the way an MCP client does; `operator` is whose cookie flips the setting. */
export async function registerClient(
  request: APIRequestContext,
  operator: Pick<Person, 'headers'>,
  clientName: string,
  redirectUri: string
): Promise<McpClient> {
  const wasOn = await dcrEnabled(request, operator.headers);
  let turnedOn = false;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!(await dcrEnabled(request, operator.headers))) {
        await setDcr(request, operator.headers, true);
        turnedOn = true;
      }
      const response = await request.post(`${MEMORY_BASE_URL}/api/mcp/oauth/register`, {
        data: {
          client_name: clientName,
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'client_secret_post',
        },
      });
      if (response.status() === 403) continue;
      expect(response.status(), await response.text()).toBe(201);
      const body: unknown = await response.json();
      const clientId =
        typeof body === 'object' && body !== null && 'client_id' in body ? body.client_id : null;
      const clientSecret =
        typeof body === 'object' && body !== null && 'client_secret' in body
          ? body.client_secret
          : null;
      if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
        throw new Error(`registration answered ${JSON.stringify(body)}`);
      }
      return { clientName, clientId, clientSecret, redirectUri };
    }
    throw new Error('dynamic client registration stayed closed');
  } finally {
    if (turnedOn && !wasOn) await setDcr(request, operator.headers, false);
  }
}

/** The authorize URL a client sends the browser to, and the verifier that goes with it. */
export function authorizeUrl(
  client: Pick<McpClient, 'clientId' | 'redirectUri'>,
  state: string
): { url: string; verifier: string } {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    state,
    scope: 'openid profile email',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return { url: `/api/mcp/oauth/authorize?${query.toString()}`, verifier };
}

/** Exchange a code from the consent page for the client's tokens. */
export async function exchangeCode(
  request: APIRequestContext,
  client: McpClient,
  code: string,
  verifier: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await request.post(`${MEMORY_BASE_URL}/api/mcp/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      code_verifier: verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    },
  });
  expect(response.ok(), `token exchange: ${await response.text()}`).toBe(true);
  const body: unknown = await response.json();
  const accessToken =
    typeof body === 'object' && body !== null && 'access_token' in body ? body.access_token : null;
  const refreshToken =
    typeof body === 'object' && body !== null && 'refresh_token' in body
      ? body.refresh_token
      : null;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new Error(`token exchange answered ${JSON.stringify(body)}`);
  }
  return { accessToken, refreshToken };
}
