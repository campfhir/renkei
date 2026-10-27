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

import { expect, type APIRequestContext } from '@playwright/test';

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
