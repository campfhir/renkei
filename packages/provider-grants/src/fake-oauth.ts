/**
 * Fake OAuth for the in-memory app (RENKEI_DATA_STORE=memory, the memory
 * UI suite): no vendor sits in a connect flow there, so the app answers
 * every leg of it itself.
 *
 *   1. Consent: where the app would send the browser to a vendor's consent
 *      page, it redirects straight back to its own callback with a code
 *      minted here (`fakeAuthorizationCode`) and the real `state`
 *      (apps/web/lib/consent-redirect.ts).
 *   2. Exchange and refresh: the delegate trades that code for a token set
 *      built here (`fakeTokenAnswer`) in the vendor's own answer shape —
 *      opaque or claim-carrying tokens as the vendor mints them, an
 *      expiry, the scopes asked for, and the provider-specific fields the
 *      callback reads (an id_token, Salesforce's instance and identity
 *      URLs) — and refreshes with `FakeOAuthAdapter`.
 *   3. Identity: the callback's identity reads on the pending token are
 *      answered here (`fakeIdentityAnswer`) with a fake account that is
 *      stable per (person, provider family): the same person reconnecting
 *      is the same account, and two people are never one.
 *
 * The callback then stores the grant through its normal code path, so the
 * grant row, its metadata and the connected UI are what production writes.
 *
 * One switch, `fakeOAuthActive()`: on only on the in-memory data store,
 * which is never a deployment (nothing it holds outlives the process). A
 * remote MCP server is left out (`fakeOAuthFor`): its authorization server
 * is the server itself, which checks the tokens it issued, not a vendor.
 */

import { randomBytes } from 'node:crypto';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { memoryDataStoreRequested } from '@renkei/db';
import type { ProviderAdapter, RefreshedTokens, RefreshError } from './types';
import {
  fakeAccount,
  fakeAtlassianSite,
  fakeOrganization,
  familyOf,
  hash,
  salesforceId,
  uuidOf,
  type FakeAccount,
} from './fake-accounts';

export { fakeAccount, fakeAtlassianSite, fakeOrganization, type FakeAccount };

/** Whether connect flows are faked: on the in-memory data store only. */
export function fakeOAuthActive(): boolean {
  return memoryDataStoreRequested();
}

/** Whether this provider's connect flow is faked (never a remote MCP server's). */
export function fakeOAuthFor(provider: string): boolean {
  return fakeOAuthActive() && !provider.startsWith('mcp:');
}

/** What a fake authorization code carries: who consented, to which provider, to what. */
export interface FakeConsent {
  subject: string;
  provider: string;
  /** The scope the consent page was asked for, as the authorize URL named it. */
  scope: string | null;
  /** Who the person works for (`fakeOrganization`): whose vendor sites they reach. */
  organization?: string;
  /**
   * The authorization request the vendor would have been sent (its consent
   * page's URL, with the client id, redirect URI and scope), kept so a
   * test can read what the app asked for.
   */
  request?: string;
}

const CODE_PREFIX = 'renkei-fake-code.';
/** A fake token's lifetime: an hour, as most vendors mint. */
const TOKEN_LIFETIME_SECONDS = 3600;

/** The code the fake consent page hands back, readable by `readFakeAuthorizationCode`. */
export function fakeAuthorizationCode(consent: FakeConsent): string {
  const body = Buffer.from(JSON.stringify(consent), 'utf8').toString('base64url');
  return `${CODE_PREFIX}${body}.${randomBytes(8).toString('hex')}`;
}

/** The consent a fake code carries, or null for any other code. */
export function readFakeAuthorizationCode(code: string): FakeConsent | null {
  if (!code.startsWith(CODE_PREFIX)) return null;
  const body = code.slice(CODE_PREFIX.length).split('.')[0] ?? '';
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const subject: unknown = Reflect.get(parsed, 'subject');
    const provider: unknown = Reflect.get(parsed, 'provider');
    const scope: unknown = Reflect.get(parsed, 'scope');
    const request: unknown = Reflect.get(parsed, 'request');
    const organization: unknown = Reflect.get(parsed, 'organization');
    if (typeof subject !== 'string' || !subject || typeof provider !== 'string' || !provider) {
      return null;
    }
    return {
      subject,
      provider,
      scope: typeof scope === 'string' ? scope : null,
      ...(typeof request === 'string' ? { request } : {}),
      ...(typeof organization === 'string' && organization ? { organization } : {}),
    };
  } catch {
    return null;
  }
}

function unsignedJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.fake`;
}

/** The vendors whose access tokens are JWTs carrying the granted scopes. */
function mintsJwtAccessTokens(provider: string): boolean {
  const family = familyOf(provider);
  return family === 'atlassian' || family === 'microsoft';
}

function accessTokenFor(provider: string, account: FakeAccount, scope: string | null): string {
  const nonce = randomBytes(12).toString('hex');
  if (!mintsJwtAccessTokens(provider)) return `fake-${provider}-${nonce}`;
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: 'renkei-fake-oauth',
    sub: account.id,
    jti: nonce,
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,
  };
  if (scope) {
    if (familyOf(provider) === 'microsoft') claims.scp = scope;
    else claims.scope = scope;
  }
  return unsignedJwt(claims);
}

/** What the exchange knows besides the code: the directory, or the org's host. */
export interface FakeExchangeContext {
  /** Microsoft: the directory tenant the app is registered in. */
  directoryTenantId?: string;
  /** Salesforce: the org's My Domain origin, which the token answer names as instance_url. */
  instanceUrl?: string;
  /** The scope the exchange itself names (Microsoft sends it again). */
  scope?: string | null;
}

/**
 * The token endpoint's answer for a fake code, shaped as the provider's
 * own: what the delegate's exchange reads and keeps.
 */
export function fakeTokenAnswer(
  provider: string,
  consent: FakeConsent,
  context: FakeExchangeContext = {}
): Record<string, unknown> {
  const account = fakeAccount(consent.subject, provider);
  let scope = context.scope || consent.scope;
  // Zoom mints the Marketplace app's whole set whatever a person narrowed
  // the request to, and that set always holds the identity scope.
  if (provider === 'zoom' && !(scope ?? '').split(/[\s,]+/).includes('user:read:user')) {
    scope = [scope, 'user:read:user'].filter(Boolean).join(' ');
  }
  const answer: Record<string, unknown> = {
    access_token: accessTokenFor(provider, account, scope),
    refresh_token: `fake-refresh-${randomBytes(12).toString('hex')}`,
    token_type: 'Bearer',
    expires_in: TOKEN_LIFETIME_SECONDS,
  };
  const family = familyOf(provider);
  // Bitbucket echoes `scopes`; everyone else `scope`.
  if (scope) answer[family === 'atlassian-bitbucket' ? 'scopes' : 'scope'] = scope;
  if (family === 'microsoft') {
    answer.id_token = unsignedJwt({
      oid: account.id,
      tid: context.directoryTenantId || uuidOf(hash(`tenant:${account.seed}`)),
      preferred_username: account.email,
      name: account.displayName,
      email: account.email,
    });
  }
  if (family === 'onbase') {
    answer.id_token = unsignedJwt({
      sub: account.id,
      name: account.displayName,
      preferred_username: account.login,
    });
  }
  if (family === 'salesforce' && context.instanceUrl) {
    const orgId = salesforceId('00D', hash(`org:${context.instanceUrl}`));
    answer.instance_url = context.instanceUrl;
    answer.id = `https://login.salesforce.com/id/${orgId}/${account.id}`;
  }
  return answer;
}

/** A fresh fake token set, for a refresh. */
export function fakeRefreshedTokens(provider: string, subject: string): RefreshedTokens {
  const account = fakeAccount(subject, provider);
  return {
    accessToken: accessTokenFor(provider, account, null),
    refreshToken: `fake-refresh-${randomBytes(12).toString('hex')}`,
    expiresAt: new Date(Date.now() + TOKEN_LIFETIME_SECONDS * 1000),
  };
}

/** Refreshes a fake grant without a vendor: a new fake token set every time. */
export class FakeOAuthAdapter implements ProviderAdapter {
  constructor(
    readonly provider: string,
    private readonly subject: string
  ) {}

  async refreshTokens(): Promise<Result<RefreshedTokens, RefreshError>> {
    return ok(fakeRefreshedTokens(this.provider, this.subject));
  }
}

/** An identity read's answer: a status and a JSON body. */
export interface FakeAnswer {
  status: number;
  body: unknown;
}

/**
 * The vendor's answer to an identity read a connect flow makes on its
 * pending token, by path (the host may be a stand-in's), or a 404 for
 * anything else: nothing but identity is read on a pending token.
 */
export function fakeIdentityAnswer(provider: string, url: URL, consent: FakeConsent): FakeAnswer {
  const account = fakeAccount(consent.subject, provider);
  // A loop, not /\/+$/, which backtracks on long runs of slashes.
  let end = url.pathname.length;
  while (end > 0 && url.pathname.charAt(end - 1) === '/') end -= 1;
  const path = url.pathname.slice(0, end);
  const family = familyOf(provider);
  if (family === 'atlassian') {
    const site = fakeAtlassianSite(consent.organization ?? consent.subject);
    if (path.endsWith('/oauth/token/accessible-resources')) {
      return {
        status: 200,
        body: [
          {
            id: site.cloudId,
            url: site.url,
            name: account.login,
            scopes: (consent.scope ?? '').split(/\s+/).filter(Boolean),
            avatarUrl: '',
          },
        ],
      };
    }
    if (path.endsWith('/rest/api/3/myself')) {
      return {
        status: 200,
        body: {
          accountId: account.id,
          accountType: 'atlassian',
          displayName: account.displayName,
          emailAddress: account.email,
          active: true,
        },
      };
    }
  }
  if (family === 'atlassian-bitbucket' && path.endsWith('/user')) {
    return {
      status: 200,
      body: {
        uuid: account.id,
        username: account.login,
        display_name: account.displayName,
        type: 'user',
      },
    };
  }
  if (family === 'github' && path.endsWith('/user')) {
    return {
      status: 200,
      body: {
        id: Number(account.id),
        login: account.login,
        name: account.displayName,
        email: account.email,
      },
    };
  }
  if (family === 'microsoft' && path.endsWith('/me')) {
    return {
      status: 200,
      body: {
        id: account.id,
        userPrincipalName: account.email,
        displayName: account.displayName,
        mail: account.email,
      },
    };
  }
  if (family === 'webex-user' && path.endsWith('/people/me')) {
    return {
      status: 200,
      body: { id: account.id, displayName: account.displayName, emails: [account.email] },
    };
  }
  if (family === 'zoom' && path.endsWith('/users/me')) {
    const [first, ...rest] = account.displayName.split(' ');
    return {
      status: 200,
      body: {
        id: account.id,
        email: account.email,
        display_name: account.displayName,
        first_name: first,
        last_name: rest.join(' '),
        account_id: uuidOf(hash(`zoom-account:${account.seed}`)),
      },
    };
  }
  if (family === 'salesforce' && path.endsWith('/services/oauth2/userinfo')) {
    return {
      status: 200,
      body: {
        user_id: account.id,
        preferred_username: account.email,
        name: account.displayName,
        email: account.email,
      },
    };
  }
  return { status: 404, body: { error: 'fake OAuth answers identity reads only' } };
}
