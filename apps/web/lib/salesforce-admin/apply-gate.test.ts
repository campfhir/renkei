/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Who may approve a Salesforce admin change: only someone with a connected
 * Salesforce Admin connection to the org — a person who merely uses the
 * CRM connector, however they got here, is refused with the reason. (The
 * approve route also requires the operator role; that is its own test.)
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/settings', () => ({ getOrgSettings: jest.fn() }));
jest.mock('@/lib/connectors/audience', () => ({ resolveAudience: jest.fn() }));
jest.mock('@/lib/mcp-tools/registry', () => ({ resolveConnectorAvailability: jest.fn() }));
jest.mock('@/lib/mcp-tools/projection', () => ({ buildProjection: jest.fn() }));
jest.mock('@/lib/salesforce-app', () => ({ listSalesforceConnectors: jest.fn() }));

jest.mock('@/lib/admin-changes/legacy-database', () => ({
  legacyDatabase: () => ({}),
  NO_DATABASE_REASON: 'no database',
}));
import { getOrgSettings } from '@renkei/settings';
import { EMPTY_POLICY, type SalesforceOrg } from '@renkei/connector-salesforce';
import { resolveAudience } from '@/lib/connectors/audience';
import { resolveConnectorAvailability } from '@/lib/mcp-tools/registry';
import { buildProjection } from '@/lib/mcp-tools/projection';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { applyGate } from './apply';

const UAT: SalesforceOrg = {
  key: 'uat',
  name: 'UAT',
  myDomain: 'https://acme--uat.sandbox.my.salesforce.com',
  host: 'acme--uat.sandbox.my.salesforce.com',
  sandbox: true,
  enabled: true,
  clientId: 'uat-client',
  scopes: [],
  policy: EMPTY_POLICY,
  productionChanges: false,
};

const passed = {
  deployId: '0Af000000000001',
  done: true,
  success: true,
  status: 'Succeeded',
  failures: [],
  checkedAt: new Date().toISOString(),
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getOrgSettings).mockResolvedValue({
    ok: true,
    val: { readOnly: false, disabledConnectors: [] },
  } as never);
  jest
    .mocked(resolveAudience)
    .mockResolvedValue({ restrictedConnectors: [], allowedConnectors: [] } as never);
  jest
    .mocked(resolveConnectorAvailability)
    .mockResolvedValue({ salesforceAdminAvailable: true } as never);
  jest.mocked(listSalesforceConnectors).mockResolvedValue([UAT]);
  jest.mocked(buildProjection).mockReturnValue({ allows: () => true } as never);
});

const change = { connectorKey: 'uat', validation: passed };

it('lets someone with a connected Salesforce Admin connection approve a validated change', async () => {
  expect(await applyGate('operator', ['renkei-operator'], change)).toEqual({ ok: true });
});

it('refuses someone who has no Salesforce Admin connection, however they use Salesforce otherwise', async () => {
  // Connected to the CRM connector only: no admin grant.
  jest
    .mocked(resolveConnectorAvailability)
    .mockResolvedValue({ salesforceAdminAvailable: false, salesforceAvailable: true } as never);
  const gate = await applyGate('crm-user', ['renkei-operator'], change);
  expect(gate.ok).toBe(false);
  expect(gate.ok === false && gate.reason).toMatch(/Salesforce Admin is not connected/);
});

it('refuses a change Salesforce has not validated', async () => {
  const gate = await applyGate('operator', ['renkei-operator'], {
    connectorKey: 'uat',
    validation: null,
  });
  expect(gate.ok).toBe(false);
  expect(gate.ok === false && gate.reason).toMatch(/has not validated/);
});
