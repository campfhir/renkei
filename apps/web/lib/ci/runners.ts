/**
 * Each host's self-hosted runners, read with the organization's service
 * accounts (accounts.ts), for the Targets page and, later, the pipeline
 * builder's checks. Read live and kept a minute, never stored.
 *
 * - GitHub: the App signs a ten-minute JWT with its private key, swaps it
 *   for an installation token for the organization
 *   (`GET /orgs/{org}/installation`, `POST /app/installations/{id}/access_tokens`)
 *   and lists `GET /orgs/{org}/actions/runners` — the App needs read
 *   access to the organization's self-hosted runners.
 * - Bitbucket: there is no public runner API. The workspace's UUID comes
 *   from `GET /2.0/workspaces/{workspace}`, and its runners from
 *   `/internal/workspaces/{uuid}/pipelines-config/runners`, the endpoint
 *   Atlassian's own runner autoscaler reads with a token holding the
 *   runner read scope. Should it stop answering, targets keep the labels
 *   they were given and pipelines are unaffected; only this list goes
 *   blank, saying why.
 */

import { createSign } from 'node:crypto';
import { parseBitbucketRunners, parseGithubRunners, type Runner } from '@renkei/ci-blocks';
import { isRecord } from '@renkei/guards';
import { GITHUB_API_BASE } from '@/lib/mcp-tools/github/client';
import { BITBUCKET_API_BASE } from '@/lib/mcp-tools/bitbucket/client';
import { REQUEST_TIMEOUT_MS, isTimeoutError, timeoutSignal } from '@/lib/mcp-tools/fetch-guard';
import type { BitbucketAccount, GithubAccount } from './accounts';

const CACHE_MS = 60_000;
const MAX_PAGES = 3;

export type RunnersRead =
  { ok: true; runners: Runner[]; readAt: string } | { ok: false; error: string };

const cache = new Map<string, { at: number; value: RunnersRead }>();

/** Forget what was read — after an account changes, and for tests. */
export function forgetRunners(): void {
  cache.clear();
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** A GitHub App's JWT: RS256, issued a minute ago against clock drift, good for nine. */
export function githubAppJwt(appId: string, privateKey: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

async function call(
  url: string,
  init: RequestInit,
  host: string
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS) });
  } catch (error) {
    return {
      ok: false,
      error: isTimeoutError(error) ? `${host} did not answer in time.` : `Could not reach ${host}.`,
    };
  }
  const body: unknown = await response.json().catch(() => null);
  return { ok: true, status: response.status, body };
}

function refusal(host: string, status: number, what: string): string {
  if (status === 401)
    return `${host} did not accept the service account’s credentials; check them and save again.`;
  if (status === 403)
    return `${host} would not let the service account read ${what}; it needs read access to self-hosted runners.`;
  if (status === 404)
    return `${host} found no such ${what}: check the name, and that the account can see it.`;
  return `${host} answered ${status} when asked for ${what}.`;
}

export async function readGithubRunners(
  account: GithubAccount,
  options: { fresh?: boolean } = {}
): Promise<RunnersRead> {
  const key = `github:${account.org}:${account.appId}`;
  const cached = cache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await githubRunnersNow(account);
  if (value.ok) cache.set(key, { at: Date.now(), value });
  return value;
}

async function githubRunnersNow(account: GithubAccount): Promise<RunnersRead> {
  let jwt: string;
  try {
    jwt = githubAppJwt(account.appId, account.privateKey);
  } catch {
    return { ok: false, error: 'The GitHub App’s private key could not be used; paste it again.' };
  }
  const headers = (token: string) => ({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  });
  const org = encodeURIComponent(account.org);
  const installation = await call(
    `${GITHUB_API_BASE}/orgs/${org}/installation`,
    { headers: headers(jwt) },
    'GitHub'
  );
  if (!installation.ok) return installation;
  if (installation.status !== 200 || !isRecord(installation.body)) {
    return {
      ok: false,
      error:
        installation.status === 404
          ? `The GitHub App is not installed on ${account.org}; install it there first.`
          : refusal('GitHub', installation.status, 'the App’s installation'),
    };
  }
  const id = String(installation.body.id ?? '');
  const minted = await call(
    `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(id)}/access_tokens`,
    { method: 'POST', headers: headers(jwt) },
    'GitHub'
  );
  if (!minted.ok) return minted;
  const token =
    isRecord(minted.body) && typeof minted.body.token === 'string' ? minted.body.token : '';
  if (minted.status !== 201 || !token)
    return { ok: false, error: refusal('GitHub', minted.status, 'an installation token') };
  const runners: Runner[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const listed = await call(
      `${GITHUB_API_BASE}/orgs/${org}/actions/runners?per_page=100&page=${page}`,
      { headers: headers(token) },
      'GitHub'
    );
    if (!listed.ok) return listed;
    if (listed.status !== 200)
      return { ok: false, error: refusal('GitHub', listed.status, `${account.org}’s runners`) };
    const batch = parseGithubRunners(listed.body);
    runners.push(...batch);
    if (batch.length < 100) break;
  }
  return { ok: true, runners, readAt: new Date().toISOString() };
}

export async function readBitbucketRunners(
  account: BitbucketAccount,
  options: { fresh?: boolean } = {}
): Promise<RunnersRead> {
  const key = `bitbucket:${account.workspace}:${account.auth}:${account.email}`;
  const cached = cache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await bitbucketRunnersNow(account);
  if (value.ok) cache.set(key, { at: Date.now(), value });
  return value;
}

async function bitbucketRunnersNow(account: BitbucketAccount): Promise<RunnersRead> {
  const headers = {
    Accept: 'application/json',
    Authorization:
      account.auth === 'basic'
        ? `Basic ${Buffer.from(`${account.email}:${account.token}`).toString('base64')}`
        : `Bearer ${account.token}`,
  };
  const workspace = await call(
    `${BITBUCKET_API_BASE}/workspaces/${encodeURIComponent(account.workspace)}`,
    { headers },
    'Bitbucket'
  );
  if (!workspace.ok) return workspace;
  const uuid =
    isRecord(workspace.body) && typeof workspace.body.uuid === 'string' ? workspace.body.uuid : '';
  if (workspace.status !== 200 || !uuid) {
    return {
      ok: false,
      error: refusal('Bitbucket', workspace.status, `workspace ${account.workspace}`),
    };
  }
  const internal = BITBUCKET_API_BASE.replace(/\/2\.0$/, '/internal');
  let next: string | null =
    `${internal}/workspaces/${encodeURIComponent(uuid)}/pipelines-config/runners?pagelen=100`;
  const runners: Runner[] = [];
  for (let page = 1; next && page <= MAX_PAGES; page += 1) {
    const listed = await call(next, { headers }, 'Bitbucket');
    if (!listed.ok) return listed;
    if (listed.status !== 200) {
      return {
        ok: false,
        error: `${refusal('Bitbucket', listed.status, `${account.workspace}’s runners`)} Bitbucket lists runners only through the endpoint its own autoscaler uses, so this can also mean Atlassian changed it; targets keep their labels either way.`,
      };
    }
    runners.push(...parseBitbucketRunners(listed.body));
    const nextUrl: unknown = isRecord(listed.body) ? listed.body.next : null;
    next = typeof nextUrl === 'string' && nextUrl.startsWith(internal) ? nextUrl : null;
  }
  return { ok: true, runners, readAt: new Date().toISOString() };
}
