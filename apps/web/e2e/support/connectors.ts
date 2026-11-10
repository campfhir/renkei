/**
 * Connector staging the way the UI does it, for the specs that need a
 * card on the person's Connectors page:
 *
 *   - `addConnectors`: the catalog's "Add" (PUT /api/connector-selections,
 *     one key at a time). The route only takes a connector the org offers
 *     the person, so an OAuth connector needs its admin config saved first.
 *   - `connectorConfig` / `saveConnectorConfig`: the admin connector
 *     page's GET and Save (GET/PUT /api/admin/connectors/<connector>), for
 *     reading what is stored and for putting an org-wide config back. The
 *     routes have no DELETE: a config the test made is disabled again,
 *     the nearest the console comes to removing it.
 */

import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { DEFAULT_ATLASSIAN_JSM_SCOPES, DEFAULT_ATLASSIAN_SCOPES } from '../../lib/atlassian-scopes';

/** The "Set up request types" box's scopes (lib/atlassian-scopes.ts), off by default. */
export const JSM_REQUEST_TYPE_SCOPES = [
  'read:servicedesk:jira-service-management',
  'read:requesttype:jira-service-management',
  'write:requesttype:jira-service-management',
];

/**
 * The scopes every spec registers the org's Jira Service Management app
 * with: its defaults and the request-type box. Its admin Save stores the
 * defaults alone when a save names no scopes, and a spec that authorizes
 * with the box (jira-admin-work-types) is refused with a 400 while another
 * spec's save has just taken it away — so every save writes this.
 */
export const E2E_JSM_SCOPES = [
  ...new Set([...DEFAULT_ATLASSIAN_JSM_SCOPES.split(' '), ...JSM_REQUEST_TYPE_SCOPES]),
].join(' ');

/** Settings every registration of a connector writes, whoever saves it. */
const SHARED_SETTINGS: Record<string, Record<string, unknown>> = {
  'atlassian-jsm': { scopes: E2E_JSM_SCOPES },
};

/** Put each connector on the signed-in person's Connectors page, as its "Add" button does. */
export async function addConnectors(
  request: APIRequestContext,
  connectors: readonly string[]
): Promise<void> {
  for (const connector of connectors) {
    const response = await request.put('/api/connector-selections', { data: { connector } });
    expect(response.ok(), `add ${connector}: ${await response.text()}`).toBe(true);
  }
}

/** What the admin connector page reads for one connector (presence, never secrets). */
export async function connectorConfig(
  request: APIRequestContext,
  connector: string
): Promise<Record<string, unknown>> {
  const response = await request.get(`/api/admin/connectors/${connector}`);
  expect(response.ok(), `GET ${connector} config: ${await response.text()}`).toBe(true);
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null ? { ...body } : {};
}

/** Save a connector's config as its admin page does. */
export async function saveConnectorConfig(
  request: APIRequestContext,
  connector: string,
  data: Record<string, unknown>
): Promise<void> {
  const response = await request.put(`/api/admin/connectors/${connector}`, { data });
  expect(response.ok(), `PUT ${connector} config: ${await response.text()}`).toBe(true);
}

/**
 * The in-memory app consents at once (fake OAuth,
 * packages/provider-grants/src/fake-oauth.ts): an authorize route's
 * redirect goes straight back to /api/oauth/callback with a fake code.
 * The code carries the authorization request the vendor would have been
 * sent — this answers it, so a spec can still check what the app asked
 * the vendor for (client id, redirect URI, scopes, its consent page).
 */
export function fakeConsentRequest(location: string): URL {
  const callback = new URL(location);
  expect(callback.pathname, `not the app's own callback: ${location}`).toBe('/api/oauth/callback');
  const code = callback.searchParams.get('code') ?? '';
  const body = code.split('.')[1] ?? '';
  const consent: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const request =
    typeof consent === 'object' && consent !== null ? Reflect.get(consent, 'request') : null;
  expect(typeof request, `no request in the fake code of ${location}`).toBe('string');
  return new URL(String(request));
}

/**
 * Connect the page's person through an authorize route (a card's Connect
 * link): on the in-memory app the fake consent answers at once and the
 * callback stores the grant as production does, ending on /connectors.
 */
export async function connectThrough(page: Page, authorize: string): Promise<void> {
  await page.goto(authorize);
  await page.waitForURL(/\/connectors(\?|$)/, { timeout: 30_000 });
}

/**
 * Register a connector's app for a test (its admin Save, switched on),
 * keeping an earlier registration's client id and the settings named in
 * `keep`. Connector configs are organization-wide and specs run side by
 * side, so a registration is switched on and left on, never off (as the
 * code hosts are, e2e/support/code-host.ts): another spec may be
 * connecting through it right now.
 */
export async function registerConnector(
  request: APIRequestContext,
  connector: string,
  data: Record<string, unknown>,
  keep: readonly string[] = []
): Promise<void> {
  const before = await connectorConfig(request, connector);
  const kept = Object.fromEntries(
    ['clientId', ...keep]
      .filter(
        (key) =>
          before.configured === true &&
          before[key] !== undefined &&
          before[key] !== null &&
          before[key] !== ''
      )
      .map((key) => [key, before[key]])
  );
  await saveConnectorConfig(request, connector, {
    ...data,
    ...SHARED_SETTINGS[connector],
    ...kept,
    enabled: true,
  });
}

/**
 * Everyday Jira registered for the org and connected for the page's
 * person, through the card's Connect link. Every spec registers it with
 * the same scopes — the defaults and the board writes a sprint card acts
 * with — since the registration is organization-wide and left on.
 */
export async function connectJira(page: Page): Promise<void> {
  await registerConnector(page.request, 'atlassian', {
    clientId: 'e2e-jira-client',
    clientSecret: 'e2e-jira-secret',
    scopes: `${DEFAULT_ATLASSIAN_SCOPES} write:board-scope:jira-software write:sprint:jira-software`,
  });
  await addConnectors(page.request, ['jira']);
  await connectThrough(page, '/api/mcp/authorize');
}
