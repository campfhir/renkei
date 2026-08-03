/**
 * The console's pages, on top of the machinery in ./admin-routes.ts.
 *
 * Each route follows the same three steps: resolve the slug to a tenant-scoped
 * `AdminStore`, authenticate (and for a POST, check the CSRF token), then read or
 * write through that store and nothing else. There is no `GatewayStore` in this
 * file, so there is no way from here to a decrypted Atlassian grant.
 */

import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { encrypt, parseEncryptionKey } from '../crypto/secretbox.js';
import {
  auditPage,
  logsPage,
  onboardSitePage,
  peoplePage,
  settingsPage,
  sitesPage,
} from '../ui/admin/console.js';
import { playbookFormPage, playbooksPage } from '../ui/admin/playbooks.js';
import { errorPage, renderPage } from '../ui/render.js';
import type { AdminDeps, OperatorGate } from './admin-routes.js';
import { resolveCloudId } from './cloud-id-resolver.js';
import { bodyText, queryString } from './request-input.js';

/** One page of audit rows. Big enough to be useful, small enough to render fast. */
const AUDIT_PAGE_SIZE = 100;

/** Matches the `tenant_playbooks_slug_shape` constraint. */
const PLAYBOOK_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function connectorBase(config: Config): string {
  return config.publicBaseUrl.replace(/\/+$/, '');
}

export function registerConsoleRoutes(
  app: FastifyInstance,
  deps: AdminDeps,
  gate: OperatorGate,
): void {
  const { config, now, fetchImpl } = deps;

  // --------------------------------------------------------------- sites

  app.get('/admin/:slug/sites', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 302);

    const sites = await admin.listSites();

    return gate.html(
      reply,
      renderPage(
        sitesPage({
          context: gate.consoleContext(context, 'sites', request),
          sites,
          connectorBase: connectorBase(config),
        }),
      ),
    );
  });

  app.post('/admin/:slug/sites/enabled', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    // Only the literal string enables it, so a malformed value disables rather
    // than enabling — the safe direction for a switch that gates access.
    const enabled = bodyText(request, 'enabled') === 'true';

    await admin.setSiteEnabled(bodyText(request, 'site'), enabled);
    return reply.redirect(`/admin/${slug}/sites?done=${enabled ? 'enabled' : 'disabled'}`, 303);
  });

  app.post('/admin/:slug/sites/claim', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    const jiraUrl = bodyText(request, 'jiraUrl').trim();
    if (!jiraUrl) {
      return reply.redirect(`/admin/${slug}/sites?done=claim-invalid`, 303);
    }

    let cloudId: string;
    try {
      cloudId = await resolveCloudId(jiraUrl, fetchImpl);
    } catch {
      return reply.redirect(`/admin/${slug}/sites?done=claim-invalid`, 303);
    }

    const result = await admin.claimSite({ cloudId, jiraUrl });

    if (result.outcome === 'conflict') {
      return reply.redirect(`/admin/${slug}/sites?done=claim-conflict`, 303);
    }

    return reply.redirect(`/admin/${slug}/sites?done=claimed`, 303);
  });

  // ------------------------------------------------------- onboard-site

  app.get('/admin/:slug/onboard-site', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 302);

    return gate.html(
      reply,
      renderPage(onboardSitePage({ context: gate.consoleContext(context, 'sites', request) })),
    );
  });

  app.post('/admin/:slug/onboard-site', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    const jiraUrl = bodyText(request, 'jiraUrl').trim();

    const again = (error: string) =>
      gate.html(
        reply,
        renderPage(
          onboardSitePage({ context: gate.consoleContext(context, 'sites', request), error }),
        ),
        400,
      );

    if (!jiraUrl) {
      return again('Please enter your Jira domain (e.g., https://mycompany.atlassian.net).');
    }

    let cloudId: string;
    try {
      cloudId = await resolveCloudId(jiraUrl, fetchImpl);
    } catch {
      return again('Unable to resolve cloud ID from Jira URL. Please verify the URL is correct.');
    }

    const result = await admin.claimSite({ cloudId, jiraUrl });

    if (result.outcome === 'conflict') {
      return again('Another tenant already has that cloud ID connected.');
    }

    return reply.redirect(`/admin/${slug}/sites?done=claimed`, 303);
  });

  // -------------------------------------------------------------- people

  app.get('/admin/:slug/people', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 302);

    const [users, sessions] = await Promise.all([admin.listUsers(), admin.listSessions()]);

    return gate.html(
      reply,
      renderPage(
        peoplePage({ context: gate.consoleContext(context, 'people', request), users, sessions }),
      ),
    );
  });

  app.post('/admin/:slug/people/revoke', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    const accountId = bodyText(request, 'account');

    if (accountId === '') return reply.redirect(`/admin/${slug}/people`, 303);

    if (bodyText(request, 'scope') === 'credential') {
      /**
       * Sessions first, then the credential.
       *
       * The other order leaves a window in which a live session has no grant
       * behind it, and a call in that window fails as a confusing internal error
       * rather than as a clean 401.
       */
      await admin.revokeSessionsForAccount(accountId, now().toISOString());
      await admin.deleteGrantsForAccount(accountId);
      return reply.redirect(`/admin/${slug}/people?done=credential-deleted`, 303);
    }

    await admin.revokeSessionsForAccount(accountId, now().toISOString());
    return reply.redirect(`/admin/${slug}/people?done=sessions-revoked`, 303);
  });

  app.post('/admin/:slug/sessions/revoke', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    await admin.revokeSession(bodyText(request, 'session'), now().toISOString());

    return reply.redirect(`/admin/${slug}/people?done=sessions-revoked`, 303);
  });

  // ----------------------------------------------------------- audit log

  app.get('/admin/:slug/audit', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 302);

    const before = queryString(request, 'before') ?? undefined;
    // One extra row, purely to find out whether there is another page. Cheaper
    // than a count over a table that only grows.
    const rows = await admin.readAuditLog({
      limit: AUDIT_PAGE_SIZE + 1,
      ...(before === undefined || Number.isNaN(Date.parse(before)) ? {} : { before }),
    });

    const page = rows.slice(0, AUDIT_PAGE_SIZE);

    return gate.html(
      reply,
      renderPage(
        auditPage({
          context: gate.consoleContext(context, 'audit', request),
          rows: page,
          nextBefore:
            rows.length > AUDIT_PAGE_SIZE ? (page[page.length - 1]?.occurredAt ?? null) : null,
        }),
      ),
    );
  });

  // ----------------------------------------------------------- error logs

  app.get('/admin/:slug/logs', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 302);

    return gate.html(
      reply,
      renderPage(
        logsPage({
          context: gate.consoleContext(context, 'logs', request),
        }),
      ),
    );
  });

  // ------------------------------------------------------------- settings

  app.get('/admin/:slug/settings', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 302);

    const key = await admin.getKeyMetadata();

    return gate.html(
      reply,
      renderPage(
        settingsPage({
          context: gate.consoleContext(context, 'settings', request),
          key,
        }),
      ),
    );
  });

  app.post('/admin/:slug/settings/key', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    const supplied = bodyText(request, 'key');

    // Base64 decoding is lenient — it drops invalid characters silently — so the
    // byte length is what actually catches a truncated or mistyped key.
    if (Buffer.from(supplied, 'base64').byteLength !== 32) {
      return gate.html(
        reply,
        errorPage(
          'That is not a 32-byte key',
          'Supply 32 bytes, base64-encoded. Generate one with: openssl rand -base64 32',
        ),
        400,
      );
    }

    /**
     * Wrapped under the deployment key before it is stored, which is what makes
     * this honestly a *per-tenant* key rather than BYOK in the sense a customer
     * means: it limits blast radius and does not exclude whoever runs the
     * deployment. Only a KMS key the tenant holds does that, and that is designed
     * rather than built.
     */
    await admin.setLiteralKey(encrypt(supplied, parseEncryptionKey(config.tokenEncryptionKey)));

    return reply.redirect(`/admin/${slug}/settings?done=key`, 303);
  });

  app.post('/admin/:slug/settings/key/clear', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    /**
     * Going back to the deployment key does not re-encrypt anything, and it does
     * not have to: grants sealed under the tenant key stay readable only while
     * that key is available, so each is rewritten under the deployment key the
     * next time it is refreshed. Anyone whose grant has not been refreshed yet
     * re-authorizes — which is why the page says so before the button is pressed.
     */
    await admin.useDeploymentKey();
    return reply.redirect(`/admin/${slug}/settings?done=key-cleared`, 303);
  });

  // ---------------------------------------------------------- playbooks

  app.get('/admin/:slug/playbooks', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 302);

    const playbooks = await admin.listPlaybooks();

    return gate.html(
      reply,
      renderPage(
        playbooksPage({ context: gate.consoleContext(context, 'playbooks', request), playbooks }),
      ),
    );
  });

  app.get('/admin/:slug/playbooks/new', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 302);

    return gate.html(
      reply,
      renderPage(playbookFormPage({ context: gate.consoleContext(context, 'playbooks', request) })),
    );
  });

  app.post('/admin/:slug/playbooks/new', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    const playbookSlug = bodyText(request, 'slug');
    const title = bodyText(request, 'title');
    const bodyMarkdown = bodyText(request, 'bodyMarkdown');

    if (!PLAYBOOK_SLUG.test(playbookSlug) || title === '' || bodyMarkdown === '') {
      return gate.html(
        reply,
        renderPage(
          playbookFormPage({
            context: gate.consoleContext(context, 'playbooks', request),
            error:
              'A title, a lowercase-letters-numbers-and-hyphens slug, and some markdown are all required.',
          }),
        ),
        400,
      );
    }

    await admin.putPlaybook({ slug: playbookSlug, title, bodyMarkdown });
    return reply.redirect(`/admin/${slug}/playbooks`, 303);
  });

  app.get('/admin/:slug/playbooks/:playbookSlug/edit', async (request, reply) => {
    const { slug, playbookSlug } = request.params as { slug: string; playbookSlug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.redirect(`/admin/${slug}`, 302);

    const playbook = await admin.getPlaybook(playbookSlug);
    if (playbook === null) return reply.redirect(`/admin/${slug}/playbooks`, 302);

    return gate.html(
      reply,
      renderPage(
        playbookFormPage({ context: gate.consoleContext(context, 'playbooks', request), playbook }),
      ),
    );
  });

  app.post('/admin/:slug/playbooks/:playbookSlug/edit', async (request, reply) => {
    const { slug, playbookSlug } = request.params as { slug: string; playbookSlug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    const title = bodyText(request, 'title');
    const bodyMarkdown = bodyText(request, 'bodyMarkdown');

    if (title === '' || bodyMarkdown === '') {
      return gate.html(
        reply,
        renderPage(
          playbookFormPage({
            context: gate.consoleContext(context, 'playbooks', request),
            playbook: { slug: playbookSlug, title, bodyMarkdown },
            error: 'A title and some markdown are both required.',
          }),
        ),
        400,
      );
    }

    await admin.putPlaybook({ slug: playbookSlug, title, bodyMarkdown });
    return reply.redirect(`/admin/${slug}/playbooks`, 303);
  });

  app.post('/admin/:slug/playbooks/:playbookSlug/enabled', async (request, reply) => {
    const { slug, playbookSlug } = request.params as { slug: string; playbookSlug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    await admin.setPlaybookEnabled(playbookSlug, bodyText(request, 'enabled') === 'true');
    return reply.redirect(`/admin/${slug}/playbooks`, 303);
  });

  app.post('/admin/:slug/playbooks/:playbookSlug/delete', async (request, reply) => {
    const { slug, playbookSlug } = request.params as { slug: string; playbookSlug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return gate.notFound(reply);

    const context = await gate.authorizeWrite(admin, slug, request, reply);
    if (context === null) return reply;

    await admin.deletePlaybook(playbookSlug);
    return reply.redirect(`/admin/${slug}/playbooks`, 303);
  });

  // -------------------------------------------------------- logs JSON API

  app.get('/api/admin/:slug/logs', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const admin = await gate.resolve(slug);
    if (admin === null) return reply.code(404).send({ error: 'Tenant not found' });

    const context = await gate.authenticate(admin, slug, request);
    if (context === null) return reply.code(401).send({ error: 'Unauthorized' });

    const q = queryString(request, 'q') || '';
    // q is a bored-logs query string like: "level:error && service:payments"
    // Pass it to the logger's query interface

    // TODO: Parse q with parseLogQueryExpr, then query logs from bored-logs
    // For now, return empty response
    return reply.send({
      logs: [],
      total: 0,
      hasMore: false,
    });
  });
}
