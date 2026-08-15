/**
 * A personal-token client for integration tests against a real Atlassian
 * sandbox. Shared across `*.integration.test.ts` suites so each one owns
 * only its own fixture data, not a second copy of how to reach the site.
 *
 * Basic auth (email + API token), not OAuth 3LO — deliberately. A script
 * cannot complete an interactive consent flow, so the 3LO path every
 * production tool uses is not available here at all.
 */

import type { JsmOpsAuth } from '../jira-service-management/ops-auth';
import type { JsmAuth } from '../jira-service-management/jsm-auth';
import type { ConfluenceAuth } from '../confluence/confluence-auth';
import type { ConfluenceAccess } from '../confluence/client';

export interface SandboxCredentials {
  email: string;
  apiToken: string;
  /** e.g. https://sandbox-north-east-medical-services.atlassian.net */
  baseUrl: string;
}

/**
 * Null when any required env var is absent — every suite's cue to skip
 * itself rather than fail. `pnpm test` must never need these; only
 * `pnpm test:integration`, run by someone who has populated
 * .env.development, does.
 */
export function sandboxCredentials(): SandboxCredentials | null {
  const email = process.env.TEST_JIRA_USER_NAME;
  const apiToken = process.env.TEST_JIRA_API_TOKEN;
  const baseUrl = process.env.TEST_JIRA_SANDBOX_API_BASE_URL;
  if (!email || !apiToken || !baseUrl) return null;
  return { email, apiToken, baseUrl };
}

function authHeader(creds: SandboxCredentials): string {
  return `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The site's Atlassian cloud id, resolved live rather than pinned as a
 * constant. A re-provisioned sandbox gets a new id, and a stale hardcoded
 * one would fail in a way that looks like the Ops API changed rather than
 * the fixture going stale.
 */
export async function resolveCloudId(creds: SandboxCredentials): Promise<string> {
  const response = await fetch(`${creds.baseUrl}/_edge/tenant_info`);
  if (!response.ok) {
    throw new Error(`Could not resolve cloud id for ${creds.baseUrl}: HTTP ${response.status}`);
  }
  const body: unknown = await response.json().catch(() => null);
  const cloudId = isRecord(body) ? body.cloudId : undefined;
  if (typeof cloudId !== 'string' || !cloudId) {
    throw new Error(`${creds.baseUrl}/_edge/tenant_info returned no cloudId`);
  }
  return cloudId;
}

/**
 * The signed-in user's own accountId — a participant every sandbox has,
 * with no dependency on any other identity existing on that site. Fixtures
 * that need a valid Atlassian user use this rather than an id copied from
 * production, which the sandbox has no reason to recognise.
 */
export async function resolveOwnAccountId(creds: SandboxCredentials): Promise<string> {
  const response = await fetch(`${creds.baseUrl}/rest/api/3/myself`, {
    headers: { Authorization: authHeader(creds), Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Could not resolve accountId on ${creds.baseUrl}: HTTP ${response.status}`);
  }
  const body: unknown = await response.json().catch(() => null);
  const accountId = isRecord(body) ? body.accountId : undefined;
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error(`${creds.baseUrl}/rest/api/3/myself returned no accountId`);
  }
  return accountId;
}

/**
 * `JsmOpsAuth` for a personal token — what `*.integration.test.ts` injects
 * where production injects `oauthJsmOpsAuth` (see `jira-service-management/
 * ops-auth.ts`).
 *
 * The base URL here is NOT the OAuth gateway (`/ex/jira/{cloudId}/jsm/
 * ops/...`) `oauthJsmOpsAuth` builds — that path accepts only a 3LO Bearer
 * token and 401s Basic auth outright, with nothing in the response to say
 * the URL was the problem. Basic auth only works against the Ops API's
 * OTHER base, the bare `/jsm/ops/api/{cloudId}/...` path Forge integrations
 * use. Building the RIGHT base for the credential this implementation
 * actually holds is exactly what the JsmOpsAuth interface is for: ops.ts
 * never sees either URL, so it cannot get this choice wrong by construction.
 *
 * `hasScopes`-equivalent enforcement is absent on purpose: a personal token
 * authenticates as a real Atlassian user with that user's full standing,
 * not a delegated OAuth grant, so there is no narrower permission to check
 * a call against. Every call this returns just goes through.
 */
export function patJsmOpsAuth(creds: SandboxCredentials, cloudId: string): JsmOpsAuth {
  const base = `https://api.atlassian.com/jsm/ops/api/${cloudId}/v1`;
  return {
    kind: 'pat',
    async fetch(_requiredScopes, path, init) {
      return fetch(`${base}${path}`, {
        ...init,
        headers: {
          Authorization: authHeader(creds),
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
    },
  };
}

/**
 * `ConfluenceAuth` for a personal token — what `confluence.integration.test.ts`
 * injects where production injects `oauthConfluenceAuth` (see
 * `confluence/confluence-auth.ts`).
 *
 * Unlike Ops, Confluence's Basic auth works against BOTH the bare
 * `/wiki/api/v2/...` path and the `/ex/confluence/{cloudId}/wiki/...`
 * gateway (confirmed directly against the sandbox) — so client.ts's
 * existing gateway URL needs no swapping, only the auth header does.
 * Confirmed separately that a personal token does NOT work as a Bearer
 * token (404 on both paths) — hence ConfluenceAccess carrying a full
 * `authHeader` rather than client.ts hardcoding `Bearer ${accessToken}`.
 *
 * No scope enforcement, same reasoning as `patJsmOpsAuth`: a personal token
 * authenticates as a real user with that user's full standing.
 */
/**
 * `JsmAuth` for a personal token — what `jsm.integration.test.ts` injects
 * where production injects `oauthJsmAuth` (see
 * `jira-service-management/jsm-auth.ts`).
 *
 * Same gateway URL production's `oauthJsmAuth` builds
 * (`api.atlassian.com/ex/jira/{cloudId}` — see mcp-tools/index.ts's
 * jsmContext) — confirmed directly against the sandbox that, unlike Ops,
 * this gateway accepts Basic auth fine (200 on both the gateway and the
 * bare site). The one thing that has to differ from `oauthJsmAuth` is the
 * auth scheme itself: `jiraFetch` (../common.ts) always sends `Bearer
 * ${token}`, and a personal token does not work as a Bearer token here
 * (401) — so this bypasses jiraFetch entirely rather than trying to make it
 * carry a header shape it was not built for.
 *
 * No scope enforcement, same reasoning as `patJsmOpsAuth`/`patConfluenceAuth`.
 */
export function patJsmAuth(creds: SandboxCredentials, cloudId: string): JsmAuth {
  const base = `https://api.atlassian.com/ex/jira/${cloudId}`;
  return {
    kind: 'pat',
    async fetch(_requiredScopes, path, init) {
      return fetch(`${base}${path}`, {
        ...init,
        headers: {
          Authorization: authHeader(creds),
          Accept: 'application/json',
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
    },
  };
}

export function patConfluenceAuth(
  creds: SandboxCredentials,
  cloudId: string,
  accountId: string
): ConfluenceAuth {
  const access: ConfluenceAccess = {
    accessToken: creds.apiToken,
    cloudId,
    accountId,
    authHeader: authHeader(creds),
  };
  return {
    kind: 'pat',
    resolve: async () => access,
  };
}
