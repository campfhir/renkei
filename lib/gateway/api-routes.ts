/**
 * Bearer token API for CLI operator access.
 *
 * Same operations as the console, but authenticated via OIDC ID tokens
 * (from device authorization grant) passed as bearer tokens instead of cookies.
 *
 * No cookie, no CSRF token, no HTML responses — just JSON.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { OidcClient } from './oidc.js';
import { bodyString, queryEnum, queryInt, queryString } from './request-input.js';
import { exportSiemEvents } from './siem-export.js';
import type { AdminStore } from './admin-store.js';
import type { GatewayStore } from './store.js';
import type { FetchLike } from '../auth/atlassian.js';

export interface ApiDeps {
  config: Config;
  store: GatewayStore;
  now: () => Date;
  fetchImpl: FetchLike;
}

interface ApiContext {
  store: AdminStore;
  subject: string;
  operator: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Ceilings on what one request may ask for.
 *
 * `parseInt(query.limit)` with no upper bound let `?limit=100000000` become a
 * `LIMIT` the database would honour, which is a way to make a tenant's own audit
 * log into a denial of service against the deployment.
 */
const MAX_AUDIT_PAGE = 1000;
const MAX_EXPORT_PAGE = 10_000;

const SIEM_FORMATS = ['json-lines', 'syslog'] as const;

export function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { store, now, fetchImpl } = deps;
  const oidc = new OidcClient({ fetchImpl, now });

  async function resolve(slug: string): Promise<AdminStore | null> {
    if (!SLUG.test(slug)) return null;

    const resolved = await store.resolveSlug(slug);
    if (resolved === null) return null;

    return store.admin(resolved.tenantId);
  }

  function extractBearerToken(request: FastifyRequest): string | null {
    const header = request.headers.authorization;
    if (typeof header !== 'string') return null;

    if (!header.startsWith('Bearer ')) return null;

    return header.slice(7);
  }

  async function authenticate(
    admin: AdminStore,
    request: FastifyRequest,
  ): Promise<ApiContext | null> {
    const token = extractBearerToken(request);
    if (!token) return null;

    const oidcConfig = await admin.getOidc();
    if (!oidcConfig) return null;

    try {
      const provider = await oidc.discover(oidcConfig.issuer);
      const identity = await oidc.verifyIdToken(provider, oidcConfig, token, null);

      if (!identity.subject) return null;

      return {
        store: admin,
        subject: identity.subject,
        operator: identity.displayName ?? identity.subject,
      };
    } catch {
      return null;
    }
  }

  app.get('/api/admin/:slug/sites', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (!admin) return reply.code(404).send({ error: 'unknown_tenant' });

    const context = await authenticate(admin, request);
    if (!context) return reply.code(401).send({ error: 'unauthorized' });

    const sites = await admin.listSites();
    return reply.send(sites);
  });

  app.post('/api/admin/:slug/people/revoke', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (!admin) return reply.code(404).send({ error: 'unknown_tenant' });

    const context = await authenticate(admin, request);
    if (!context) return reply.code(401).send({ error: 'unauthorized' });

    const accountId = bodyString(request, 'accountId');
    if (accountId === null) return reply.code(400).send({ error: 'accountId required' });

    await admin.revokeSessionsForAccount(accountId, now().toISOString());
    return reply.send({ success: true });
  });

  app.get('/api/admin/:slug/people', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (!admin) return reply.code(404).send({ error: 'unknown_tenant' });

    const context = await authenticate(admin, request);
    if (!context) return reply.code(401).send({ error: 'unauthorized' });

    const people = await admin.listUsers();
    return reply.send(people);
  });

  app.get('/api/admin/:slug/audit', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (!admin) return reply.code(404).send({ error: 'unknown_tenant' });

    const context = await authenticate(admin, request);
    if (!context) return reply.code(401).send({ error: 'unauthorized' });

    const options: { limit: number; before?: string } = {
      limit: queryInt(request, 'limit', 100, MAX_AUDIT_PAGE),
    };

    // `?before=` reaches a `::timestamptz` bind parameter. A repeated key made it
    // an array under the old cast, and the driver — not validation — was what
    // refused it, as a 500.
    const before = queryString(request, 'before');
    if (before !== null) options.before = before;

    const rows = await admin.readAuditLog(options);
    return reply.send(rows);
  });

  app.post('/api/admin/:slug/sessions/revoke', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (!admin) return reply.code(404).send({ error: 'unknown_tenant' });

    const context = await authenticate(admin, request);
    if (!context) return reply.code(401).send({ error: 'unauthorized' });

    const sessionId = bodyString(request, 'sessionId');
    if (sessionId === null) return reply.code(400).send({ error: 'sessionId required' });

    await admin.revokeSession(sessionId, now().toISOString());
    return reply.send({ success: true });
  });

  app.get('/api/admin/:slug/export/siem', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await resolve(slug);
    if (!admin) return reply.code(404).send({ error: 'unknown_tenant' });

    const context = await authenticate(admin, request);
    if (!context) return reply.code(401).send({ error: 'unauthorized' });

    const opts: {
      limit?: number;
      before?: string;
      format?: 'json-lines' | 'syslog';
      hostname?: string;
    } = {
      limit: queryInt(request, 'limit', 1000, MAX_EXPORT_PAGE),
      // Constrained rather than cast: `?format=xml` used to become a value the
      // exporter's own type said was impossible.
      format: queryEnum(request, 'format', SIEM_FORMATS, 'json-lines'),
      hostname: queryString(request, 'hostname') ?? 'renkei',
    };

    const before = queryString(request, 'before');
    if (before !== null) opts.before = before;

    const result = await exportSiemEvents(admin, admin.tenantId, opts);

    reply.type(result.contentType).send(result.data);
  });
}
