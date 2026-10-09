/**
 * Git over HTTPS for code workspaces, through the delegate
 * (docs/delegate-key-design.md). The last place a token used to leave
 * this process was the `Basic` header a workspace's git needed; now the
 * sandbox worker's git is pointed at `<delegate>/git/<ticket>/<host>/…`
 * for the one clone, pull or push, and this module relays the smart-HTTP
 * exchange to the real host with the person's token attached.
 *
 *   grant/git-ticket  — `{ provider, subject, write }`: a ticket
 *                       bound to one person, one provider's host and one
 *                       direction, good for a few minutes. Answers the
 *                       ticket and the host; the caller builds the proxy
 *                       base from the delegate's own address.
 *   /git/<ticket>/<host>/<owner>/<repo>.git/info/refs?service=…
 *   /git/<ticket>/<host>/<owner>/<repo>.git/git-upload-pack
 *   /git/<ticket>/<host>/<owner>/<repo>.git/git-receive-pack
 *                     — the three requests smart HTTP makes, streamed both
 *                       ways. A read ticket never reaches receive-pack.
 *
 * The ticket is the credential for these routes (there is no bearer
 * key on the sandbox side, by design): random, hashed at rest, expiring,
 * and worth exactly one person's grant on one host.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { sendJson, str } from '@renkei/worker-kit';
import type { Grants } from './grants';
import { statusForGrantError } from './grants';

/** How long a ticket may start requests; a clone already under way runs to its end. */
export const GIT_TICKET_TTL_MS = 15 * 60_000;
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;

/** Which host a provider's repositories live on, and the fixed username its token rides as. */
const HOSTS: Readonly<Record<string, { host: string; user: string }>> = {
  [GITHUB]: { host: 'github.com', user: 'x-access-token' },
  [ATLASSIAN_BITBUCKET]: { host: 'bitbucket.org', user: 'x-token-auth' },
};

const PATH =
  /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'host',
  'authorization',
]);

export interface GitUpstreamAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

/** How the proxy reaches the host; injected in tests, node's own client in production. */
export type GitDialer = (
  target: URL,
  init: { method: string; headers: Record<string, string>; body: Readable | null }
) => Promise<GitUpstreamAnswer>;

export const nodeGitDialer: GitDialer = (target, init) =>
  new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      target,
      { method: init.method, headers: init.headers, timeout: UPSTREAM_TIMEOUT_MS },
      (response) => {
        resolve({ status: response.statusCode ?? 502, headers: response.headers, body: response });
      }
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (init.body) init.body.pipe(request);
    else request.end();
  });

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class GitTickets {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly grants: Grants,
    private readonly dial: GitDialer = nodeGitDialer
  ) {}

  /** `grant/git-ticket` */
  async issue(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const tenantId = str(body.tenantId);
    const provider = str(body.provider);
    const subject = str(body.subject);
    const write = body.write === true;
    if (!tenantId || !provider || !subject) {
      return sendJson(response, 400, { error: { type: 'bad_request' } });
    }
    const host = Object.prototype.hasOwnProperty.call(HOSTS, provider) ? HOSTS[provider] : null;
    if (!host) {
      return sendJson(response, 403, {
        error: { type: 'host_not_allowed', message: 'git runs against GitHub and Bitbucket only' },
      });
    }
    // The grant must exist and open now, so a missing connection fails at
    // the ask and not minutes later inside git's output.
    const access = await this.grants.accessFor(tenantId, provider, { subject });
    if (!access.ok) {
      return sendJson(response, access.status, { error: { type: access.error } });
    }
    const id = randomUUID();
    const secret = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + GIT_TICKET_TTL_MS);
    await this.db
      .insertInto('delegate_git_tickets')
      .values({
        id,
        subject,
        provider,
        host: host.host,
        write,
        secret_hash: hashSecret(secret),
        expires_at: expiresAt,
      })
      .execute();
    void this.sweep();
    sendJson(response, 200, {
      ticket: `${id}.${secret}`,
      host: host.host,
      insteadOf: `https://${host.host}/`,
      expiresAt: expiresAt.toISOString(),
    });
  }

  /** `/git/<ticket>/<host>/<owner>/<repo>.git/<verb>` */
  async proxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://delegate.internal');
    const match = /^\/git\/([0-9a-f-]{36})\.([0-9a-f]{48})\/([a-z0-9.-]+)(\/.*)$/.exec(
      url.pathname
    );
    if (!match) return refuse(response, 404, 'not_found');
    const [, id, secret, host, rest] = match;
    const path = PATH.exec(rest);
    if (!path) return refuse(response, 404, 'not_found');
    const verb = path[3];
    const service = url.searchParams.get('service');
    const method = request.method ?? 'GET';
    if (
      verb === 'info/refs' &&
      (method !== 'GET' || !service || !/^git-(upload|receive)-pack$/.test(service))
    ) {
      return refuse(response, 400, 'bad_request');
    }
    if (verb !== 'info/refs' && method !== 'POST')
      return refuse(response, 405, 'method_not_allowed');

    const ticket = await this.db
      .selectFrom('delegate_git_tickets')
      .select(['subject', 'provider', 'host', 'write', 'secret_hash', 'expires_at'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (
      !ticket ||
      !sameHash(ticket.secret_hash, hashSecret(secret)) ||
      ticket.host !== host ||
      ticket.expires_at.getTime() <= Date.now()
    ) {
      return refuse(response, 404, 'not_found');
    }
    const writing = verb === 'git-receive-pack' || service === 'git-receive-pack';
    if (writing && !ticket.write) return refuse(response, 403, 'read_only_ticket');

    const access = await this.grants.accessFor(ticket.tenant_id, ticket.provider, {
      subject: ticket.subject,
    });
    if (!access.ok) return refuse(response, statusForGrantError(access.error), access.error);
    const user = Object.prototype.hasOwnProperty.call(HOSTS, ticket.provider)
      ? HOSTS[ticket.provider].user
      : 'x-access-token';

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (HOP_BY_HOP.has(name) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    headers.authorization = `Basic ${Buffer.from(`${user}:${access.token}`).toString('base64')}`;

    const target = new URL(`https://${host}${rest}${url.search}`);
    let upstream: GitUpstreamAnswer;
    try {
      upstream = await this.dial(target, {
        method,
        headers,
        body: method === 'POST' ? request : null,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'timeout';
      return refuse(response, timedOut ? 504 : 502, timedOut ? 'timeout' : 'unreachable');
    }
    response.statusCode = upstream.status;
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (HOP_BY_HOP.has(name) || name === 'content-length' || value === undefined) continue;
      response.setHeader(name, value);
    }
    upstream.body.on('error', () => response.destroy());
    upstream.body.pipe(response);
  }

  /** Expired tickets go as new ones are issued; nothing waits on this. */
  private async sweep(): Promise<void> {
    try {
      await this.db
        .deleteFrom('delegate_git_tickets')
        .where('expires_at', '<', new Date(Date.now() - 60_000))
        .execute();
    } catch {
      // The next issue tries again.
    }
  }
}

function refuse(response: ServerResponse, status: number, type: string): void {
  sendJson(response, status, { error: { type } });
}
