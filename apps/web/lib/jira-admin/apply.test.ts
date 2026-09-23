/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Who may apply a Jira admin change request: the same org rules that
 * decide whether the proposal tools register at all — read-only mode, the
 * org's off switch, the connector's audience, a connected grant with the
 * scope the writes need. Each refusal names its reason, since the review
 * page shows it in place of a working Apply button.
 */

jest.mock('@renkei/settings', () => ({ getOrgSettings: jest.fn() }));
jest.mock('@/lib/connectors/audience', () => ({ resolveAudience: jest.fn() }));
jest.mock('@/lib/mcp-tools/jira-admin', () => ({ JIRA_ADMIN_MCP_CONNECTOR: 'jira-admin' }));
jest.mock('@/lib/mcp-tools/registry', () => ({
  resolveConnectorAvailability: jest.fn(),
  provisionedConnectorsFor: (availability: { jiraAdminAvailable: boolean }) =>
    availability.jiraAdminAvailable ? ['jira-admin'] : [],
}));
jest.mock('@/lib/mcp-tools/jira-admin/client', () => ({}));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { resolveAudience } from '@/lib/connectors/audience';
import { resolveConnectorAvailability } from '@/lib/mcp-tools/registry';
import { applyGate } from './apply';

const db = {} as unknown as Kysely<DB>;

let settings: { readOnly: boolean; disabledConnectors: string[] };
let audience: { restrictedConnectors: string[]; allowedConnectors: string[] };
let availability: { jiraAdminAvailable: boolean; jiraAdminScopes: string[] };

beforeEach(() => {
  settings = { readOnly: false, disabledConnectors: [] };
  audience = { restrictedConnectors: [], allowedConnectors: [] };
  availability = {
    jiraAdminAvailable: true,
    jiraAdminScopes: ['read:jira-user', 'read:jira-work', 'manage:jira-configuration'],
  };
  jest
    .mocked(getOrgSettings)
    .mockImplementation(async () => ({ ok: true, val: settings }) as never);
  jest.mocked(resolveAudience).mockImplementation(async () => audience);
  jest.mocked(resolveConnectorAvailability).mockImplementation(async () => availability as never);
});

const gate = () => applyGate(db, 'tenant-1', 'owner', [], 'field_options');

it('allows a connected Jira admin in an org that allows it', async () => {
  expect(await gate()).toEqual({ ok: true });
});

it('refuses in read-only mode', async () => {
  settings.readOnly = true;
  expect(await gate()).toEqual({
    ok: false,
    reason: 'Your organization is in read-only mode, so admin changes cannot be applied.',
  });
});

it('refuses once the org switches Jira Administration off', async () => {
  settings.disabledConnectors = ['jira-admin'];
  expect(await gate()).toMatchObject({ ok: false, reason: expect.stringMatching(/switched off/) });
});

it('refuses someone outside the connector’s audience', async () => {
  audience = { restrictedConnectors: ['jira-admin'], allowedConnectors: [] };
  expect(await gate()).toMatchObject({
    ok: false,
    reason: expect.stringMatching(/limits Jira Administration to certain people/),
  });
  audience = { restrictedConnectors: ['jira-admin'], allowedConnectors: ['jira-admin'] };
  expect(await gate()).toEqual({ ok: true });
});

it('refuses without a connection, or without the scope the writes need', async () => {
  availability = { jiraAdminAvailable: false, jiraAdminScopes: [] };
  expect(await gate()).toMatchObject({ ok: false, reason: expect.stringMatching(/not connected/) });

  availability = { jiraAdminAvailable: true, jiraAdminScopes: ['read:jira-work'] };
  expect(await gate()).toEqual({
    ok: false,
    reason:
      'Your Jira Administration connection does not include manage:jira-configuration. ' +
      'Reconnect it with Site configuration ticked.',
  });
});
