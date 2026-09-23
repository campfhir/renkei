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
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { resolveAudience } from '@/lib/connectors/audience';
import { resolveConnectorAvailability } from '@/lib/mcp-tools/registry';
import { applyGate, changeScopes } from './apply';
import { planSpaceCreation, type CreateSpacePayload } from './space-creation';

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

const gate = () => applyGate(db, 'tenant-1', 'owner', [], { kind: 'field_options', payload: {} });

/** A new space, with or without components. */
function newSpace(components: string[]): { kind: string; payload: CreateSpacePayload } {
  return {
    kind: 'create_space',
    payload: {
      source: { kind: 'space', key: 'OPS' },
      workflowUsage: null,
      operations: planSpaceCreation({
        key: 'FIN',
        name: 'Finance',
        description: null,
        lead: { accountId: 'acct-dana', displayName: 'Dana Admin' },
        base: {
          projectTypeKey: 'software',
          assigneeType: null,
          category: null,
          schemes: {
            issueTypeScheme: { id: '11', name: 'a' },
            issueTypeScreenScheme: { id: '12', name: 'b' },
            workflowScheme: { id: '13', name: 'c' },
            fieldConfigurationScheme: null,
            permissionScheme: { id: '15', name: 'd' },
            notificationScheme: { id: '16', name: 'e' },
            issueSecurityScheme: null,
          },
          roles: [],
          components: null,
        },
        members: [],
        components,
      }),
    },
  };
}

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
      'Reconnect it with Site configuration ticked (if it is not offered, an organization ' +
      'admin allows it under Connector setup first).',
  });
});

it('names every box a new space needs that the connection lacks', async () => {
  availability = { jiraAdminAvailable: true, jiraAdminScopes: ['read:jira-user'] };
  expect(await applyGate(db, 'tenant-1', 'owner', [], newSpace([]))).toEqual({
    ok: false,
    reason:
      'Your Jira Administration connection does not include read:jira-work, ' +
      'manage:jira-configuration. Reconnect it with Read access & space details and Site ' +
      'configuration ticked (if it is not offered, an organization admin allows it under ' +
      'Connector setup first).',
  });
});

it('asks for the components permission only when the new space has components', async () => {
  expect(await applyGate(db, 'tenant-1', 'owner', [], newSpace([]))).toEqual({ ok: true });
  expect(await applyGate(db, 'tenant-1', 'owner', [], newSpace(['Backend']))).toEqual({
    ok: false,
    reason:
      'Your Jira Administration connection does not include manage:jira-project. Reconnect ' +
      'it with Space components, versions and screens ticked (if it is not offered, an ' +
      'organization admin allows it under Connector setup first).',
  });
});

it('asks for every admin scope for a change it cannot read', () => {
  expect(changeScopes({ kind: 'create_space', payload: { nonsense: true } })).toEqual([
    'read:jira-work',
    'manage:jira-configuration',
    'manage:jira-project',
  ]);
});
