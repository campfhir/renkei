import { field, send, type CrawlPage } from './types';

/**
 * Pages of this area the memory crawl visits; see ./types.ts. The feed's
 * cards, knowledge, the activity log and tool usage are written by
 * connectors and background work, so those pages show their empty states.
 */

export const generalPages: CrawlPage[] = [
  { path: '/', expectText: 'Nothing suggested yet.' },
  // The old address redirects to the feed, query string and all.
  { path: '/home?archived=1', expectText: 'The full history, archived cards included.' },
  { path: '/knowledge', expectText: 'Knowledge search' },
  { path: '/logs', expectText: 'Every account in this tenant' },
  {
    // A desktop client registers itself (RFC 7591) and sends the person to
    // authorize it; the authorize route parks the request and redirects
    // to the consent page.
    path: '/oauth/consent',
    stage: async ({ api, tag, cleanup }) => {
      // Dynamic client registration is an organization setting, off by
      // default: on for this page, and back as it was afterwards.
      const current = await api.get('/api/admin/org-settings');
      const body: unknown = await current.json();
      const settings =
        typeof body === 'object' && body !== null && 'settings' in body ? body.settings : null;
      const wasOn =
        typeof settings === 'object' && settings !== null && 'enableDcr' in settings
          ? settings.enableDcr === true
          : false;
      if (!wasOn) {
        await send(api, 'put', '/api/admin/org-settings', { enableDcr: true });
        cleanup(async () => {
          await send(api, 'put', '/api/admin/org-settings', { enableDcr: false });
        });
      }
      const redirectUri = 'http://127.0.0.1:43123/callback';
      const client = await send(api, 'post', '/api/mcp/oauth/register', {
        client_name: `Crawl desktop client ${tag}`,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      });
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: field(client, 'client_id'),
        redirect_uri: redirectUri,
        state: 'crawl',
        scope: 'openid profile email',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      });
      const authorized = await api.get(`/api/mcp/oauth/authorize?${query}`, { maxRedirects: 0 });
      const location = authorized.headers().location ?? '';
      if (!location.includes('/oauth/consent')) {
        throw new Error(`authorize answered ${authorized.status()} → ${location}`);
      }
      const consent = new URL(location, 'http://127.0.0.1');
      return `${consent.pathname}${consent.search}`;
    },
    expectText: /^Allow Crawl desktop client crawl-[0-9a-f]+ to act as you\?$/,
  },
];
