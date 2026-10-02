/**
 * The token side of the delegate, as a caller sees it: `delegateFetch`
 * looks like `fetch`, takes a grant reference instead of a token, and
 * answers the provider's own Response — status, headers and body as the
 * provider sent them. The Authorization header is attached by the
 * delegate; a caller that sets one has it dropped.
 *
 * Every token consumer in the web app and the workers becomes a consumer
 * of an `AuthedFetch` built here, and the word "accessToken" leaves those
 * processes.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { DelegateTransport, delegateConfigFromEnv, isRecord, type FetchLike } from './transport';

/** Whose grant a request rides on. One of subject, accountId or pending is required. */
export interface GrantRef {
  tenantId: string;
  provider: string;
  /** The person, when the caller knows them by OIDC subject. */
  subject?: string;
  /** The provider account, when the caller already resolved the row (webhooks, workers). */
  accountId?: string;
  /** A just-exchanged token that is not a grant yet (the connect flow's identity calls). */
  pending?: string;
}

/** `fetch` with the credential supplied by whoever built it. */
export type AuthedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DelegateFetchOptions {
  /** Follow redirects at the delegate (default) or hand the 3xx back untouched. */
  redirect?: 'follow' | 'manual';
  timeoutMs?: number;
}

/** The delegate's own refusal, when it never reached the provider; null for a provider answer. */
export function delegateRefusal(response: Response): string | null {
  return response.headers.get('x-delegate-error');
}

/** A Response that reads as the delegate refusing, for the cases where there is nothing to send. */
function refusal(type: string, status: number, message?: string): Response {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'x-delegate-error': type },
  });
}

/**
 * What the delegate's exchange answers: the handle that stands for the
 * tokens, and the identity-bearing, non-secret parts of the answer.
 */
export interface ExchangeOutcome {
  handle: string;
  expiresAt: string;
  scope: string | null;
  idToken: string | null;
  grantedScopes: string[] | null;
  hasRefreshToken: boolean;
}

export interface GrantDescription {
  provider: string;
  accountId: string;
  clientId: string;
  displayName: string;
  expiresAt: string;
  requestedScopes: string[];
  grantedScopes: string[] | null;
  metadata: Record<string, unknown>;
  subject: string | null;
}

export type GrantOpError =
  | 'DELEGATE_UNCONFIGURED'
  | 'DELEGATE_UNREACHABLE'
  | 'DELEGATE_ERROR'
  | 'unknown_provider'
  | 'NO_GRANT'
  | 'GRANT_UNREADABLE'
  | 'GRANT_REVOKED'
  | 'REFRESH_FAILED'
  | 'NOT_CONFIGURED'
  | 'EXCHANGE_FAILED'
  | 'NO_PENDING';

const GRANT_OP_ERRORS: readonly GrantOpError[] = [
  'DELEGATE_UNCONFIGURED',
  'DELEGATE_UNREACHABLE',
  'unknown_provider',
  'NO_GRANT',
  'GRANT_UNREADABLE',
  'GRANT_REVOKED',
  'REFRESH_FAILED',
  'NOT_CONFIGURED',
  'EXCHANGE_FAILED',
  'NO_PENDING',
];

function grantOpError(type: string): GrantOpError {
  return GRANT_OP_ERRORS.find((known) => known === type) ?? 'DELEGATE_ERROR';
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export class DelegateGrants {
  constructor(
    private readonly transport: DelegateTransport,
    private readonly url: string | null,
    private readonly apiKey: string | null,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)
  ) {}

  static fromEnv(fetchImpl?: FetchLike): DelegateGrants {
    const config = delegateConfigFromEnv();
    return new DelegateGrants(
      new DelegateTransport(config, fetchImpl),
      config?.url ?? null,
      config?.apiKey ?? null,
      fetchImpl
    );
  }

  /**
   * One request to the provider on the grant. `init` is an ordinary
   * RequestInit; its body may be a string, bytes, URLSearchParams or
   * FormData (the multipart boundary is worked out here, the way fetch
   * would), never a stream.
   */
  async fetch(
    grant: GrantRef,
    url: string,
    init: RequestInit = {},
    options: DelegateFetchOptions = {}
  ): Promise<Response> {
    if (!this.url || !this.apiKey) return refusal('DELEGATE_UNCONFIGURED', 503);
    // Let the platform serialize the body (FormData boundaries, URLSearchParams
    // encoding) by building the request it would have sent, then reading it.
    const staged = new Request(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
    });
    const forward: Record<string, string> = {};
    staged.headers.forEach((value, name) => {
      if (name.toLowerCase() !== 'authorization') forward[name] = value;
    });
    const method = staged.method.toUpperCase();
    const body =
      method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await staged.arrayBuffer());
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/octet-stream',
      'x-delegate-grant': JSON.stringify(grant),
      'x-delegate-url': url,
      'x-delegate-method': method,
      'x-delegate-headers': JSON.stringify(forward),
      'x-delegate-redirect': options.redirect ?? 'follow',
    };
    if (options.timeoutMs) headers['x-delegate-timeout-ms'] = String(options.timeoutMs);
    try {
      return await this.fetchImpl(`${this.url}/v1/api`, {
        method: 'POST',
        headers,
        body,
        signal: init.signal ?? undefined,
      });
    } catch (error) {
      return refusal(
        'DELEGATE_UNREACHABLE',
        503,
        error instanceof Error ? error.message : undefined
      );
    }
  }

  /** An `AuthedFetch` bound to one grant, for the clients that take a fetcher. */
  fetcher(grant: GrantRef, options: DelegateFetchOptions = {}): AuthedFetch {
    return (url, init) => this.fetch(grant, url, init, options);
  }

  async exchange(input: {
    tenantId: string;
    provider: string;
    form: Record<string, string>;
    directoryTenantId?: string;
  }): Promise<Result<ExchangeOutcome, GrantOpError>> {
    const answer = await this.transport.call('oauth/exchange', { ...input });
    if (!answer.ok) return err(grantOpError(answer.err.type), { message: answer.err.message });
    const value = answer.val;
    if (typeof value.handle !== 'string' || typeof value.expiresAt !== 'string')
      return err('DELEGATE_ERROR');
    return ok({
      handle: value.handle,
      expiresAt: value.expiresAt,
      scope: typeof value.scope === 'string' ? value.scope : null,
      idToken: typeof value.idToken === 'string' ? value.idToken : null,
      grantedScopes: Array.isArray(value.grantedScopes) ? stringsOf(value.grantedScopes) : null,
      hasRefreshToken: value.hasRefreshToken === true,
    });
  }

  async commit(input: {
    tenantId: string;
    provider: string;
    handle: string;
    subject: string;
    accountId: string;
    displayName: string;
    clientId?: string;
    requestedScopes: string[];
    metadata: Record<string, unknown>;
  }): Promise<Result<void, GrantOpError>> {
    const answer = await this.transport.call('grant/commit', { ...input });
    return answer.ok
      ? ok(undefined)
      : err(grantOpError(answer.err.type), { message: answer.err.message });
  }

  async describe(grant: GrantRef): Promise<Result<GrantDescription, GrantOpError>> {
    const answer = await this.transport.call('grant/describe', { ...grant });
    if (!answer.ok) return err(grantOpError(answer.err.type));
    const value = answer.val;
    if (typeof value.accountId !== 'string') return err('DELEGATE_ERROR');
    return ok({
      provider: typeof value.provider === 'string' ? value.provider : grant.provider,
      accountId: value.accountId,
      clientId: typeof value.clientId === 'string' ? value.clientId : '',
      displayName: typeof value.displayName === 'string' ? value.displayName : '',
      expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : '',
      requestedScopes: stringsOf(value.requestedScopes),
      grantedScopes: Array.isArray(value.grantedScopes) ? stringsOf(value.grantedScopes) : null,
      metadata: isRecord(value.metadata) ? value.metadata : {},
      subject: typeof value.subject === 'string' ? value.subject : null,
    });
  }

  /** Revoke at the provider where one can (Zoom, OnBase), then delete our copy. */
  async revoke(input: {
    tenantId: string;
    provider: string;
    accountId: string;
  }): Promise<Result<{ revokedAtProvider: boolean }, GrantOpError>> {
    const answer = await this.transport.call('grant/revoke', { ...input });
    if (!answer.ok) return err(grantOpError(answer.err.type));
    return ok({ revokedAtProvider: answer.val.revokedAtProvider === true });
  }

  async delete(input: {
    tenantId: string;
    provider: string;
    accountId: string;
  }): Promise<Result<void, GrantOpError>> {
    const answer = await this.transport.call('grant/delete', { ...input });
    return answer.ok ? ok(undefined) : err(grantOpError(answer.err.type));
  }
}

let shared: DelegateGrants | null = null;

/** The process-wide grant client, built once from the environment. */
export function delegateGrants(): DelegateGrants {
  shared ??= DelegateGrants.fromEnv();
  return shared;
}

/** Tests: replace the process-wide grant client (null restores the env-built one). */
export function setDelegateGrants(client: DelegateGrants | null): void {
  shared = client;
}

/** The common case in one call: a fetcher for a person's grant on a provider. */
export function grantFetch(grant: GrantRef, options?: DelegateFetchOptions): AuthedFetch {
  return delegateGrants().fetcher(grant, options);
}
