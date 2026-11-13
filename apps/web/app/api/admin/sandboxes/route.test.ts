/**
 * The sandbox setup routes (GET/PUT /api/admin/sandboxes and
 * …/test-connection), on the memory store: what the Sandboxes page's
 * Save stores and seals, what it refuses, that no secret's value is ever
 * answered back, and that a test hands the orchestrator the setup about
 * to be saved (sandboxes-form.model.test.ts holds the form's own rules;
 * @renkei/sandbox-client's orchestrator-config.test.ts what a valid setup
 * is).
 */

jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@renkei/sandbox-client', () => ({
  ...jest.requireActual('@renkei/sandbox-client'),
  checkSandboxOrchestrator: jest.fn(),
  sandboxOrchestratorStatus: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { getConnectorConfig, invalidateConnectorConfigCache } from '@renkei/connector-config';
import { loadKeyring } from '@renkei/crypto';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET, PUT } from './route';
import { POST as TEST } from './test-connection/route';

const { checkAccess } = jest.requireMock<{ checkAccess: jest.Mock }>('@/lib/access');
const { recordAuditEvent } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);
const client = jest.requireMock<Record<string, jest.Mock>>('@renkei/sandbox-client');

const STATUS = { wired: true, reachable: true, provider: null, problem: 'not set up yet' };
const AZURE = {
  subscriptionId: 'bcc23553-20c2-4009-a5e2-ef2740dd125f',
  resourceGroup: 'PRD_INFRA',
  sandboxGroup: 'renkei-sandbox-group',
  region: 'eastus2',
  diskImage: 'renkei-sandbox',
  entraAllowed: ['orchestrator@contoso.com'],
  tenantId: '11111111-2222-4333-8444-555555555555',
  clientId: '66666666-7777-4888-8999-000000000000',
};
const FORM = {
  enabled: true,
  provider: 'azure',
  azure: AZURE,
  envNames: ['DATABASE_URL'],
  envValues: { DATABASE_URL: 'postgres://sandbox:pw@db/renkei' },
  azureClientSecret: 'client-s3cret',
};

const request = (method: string, body?: unknown, path = '') =>
  new NextRequest(`http://test.local/api/admin/sandboxes${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The row as stored, secrets opened — what the orchestrator reads. */
async function storedRow() {
  const key = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!key.ok) throw new Error('no key');
  const row = await getConnectorConfig('sandbox-orchestrator', key.val);
  if (!row.ok) throw new Error('unreadable');
  return row.val;
}

const savedKey = process.env.TOKEN_ENCRYPTION_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  registerDataStore(createMemoryDataStore());
  invalidateConnectorConfigCache();
  checkAccess.mockResolvedValue({ subject: 'operator@example.com' });
  client.sandboxOrchestratorStatus!.mockResolvedValue(STATUS);
});

afterEach(() => {
  resetDataStore();
  if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

describe('GET /api/admin/sandboxes', () => {
  it('answers the defaults, not configured, with what the orchestrator says of itself', async () => {
    const response = await GET(request('GET'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: false,
      enabled: false,
      envStored: [],
      hasAzureClientSecret: false,
      orchestrator: STATUS,
    });
  });

  it('is for operators', async () => {
    checkAccess.mockResolvedValue(null);
    expect((await GET(request('GET'))).status).toBe(401);
    expect((await PUT(request('PUT', FORM))).status).toBe(401);
    expect((await TEST(request('POST', FORM, '/test-connection'))).status).toBe(401);
    expect(await storedRow()).toBeNull();
  });
});

describe('PUT /api/admin/sandboxes', () => {
  it('stores the setup with its secrets sealed, and answers which are stored — never what they are', async () => {
    const response = await PUT(request('PUT', FORM));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('client-s3cret');
    expect(text).not.toContain('postgres://sandbox');
    expect(JSON.parse(text)).toMatchObject({
      configured: true,
      enabled: true,
      hasAzureClientSecret: true,
      envStored: ['DATABASE_URL'],
      settings: { provider: 'azure', azure: { sandboxGroup: 'renkei-sandbox-group' } },
    });

    // What the orchestrator reads back.
    expect(await storedRow()).toMatchObject({
      enabled: true,
      settings: { provider: 'azure', envNames: ['DATABASE_URL'] },
      secrets: {
        azureClientSecret: 'client-s3cret',
        'env.DATABASE_URL': 'postgres://sandbox:pw@db/renkei',
      },
    });
    // And GET, afterwards, says no more than the save did.
    const read = await (await GET(request('GET'))).text();
    expect(read).not.toContain('client-s3cret');
    expect(read).not.toContain('postgres://sandbox');
  });

  it('records who configured sandboxes and where, without a value', async () => {
    await PUT(request('PUT', FORM));
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubject: 'operator@example.com',
        action: 'sandboxes.configured',
        details: expect.objectContaining({
          provider: 'azure',
          sandboxGroup: 'renkei-sandbox-group',
          envNames: ['DATABASE_URL'],
        }),
      })
    );
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain('s3cret');
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain('postgres://');
  });

  it('keeps a stored secret when its field is left blank, replaces one that is typed, and drops a variable no longer named', async () => {
    await PUT(
      request('PUT', {
        ...FORM,
        envNames: ['DATABASE_URL', 'OLD'],
        envValues: { DATABASE_URL: 'a', OLD: 'b' },
      })
    );
    const response = await PUT(
      request('PUT', {
        ...FORM,
        azureClientSecret: null,
        envNames: ['DATABASE_URL', 'DELEGATE_WORKER_API_KEY'],
        envValues: { DELEGATE_WORKER_API_KEY: 'delegate-key' },
      })
    );
    expect(response.status).toBe(200);
    expect((await storedRow())?.secrets).toEqual({
      azureClientSecret: 'client-s3cret',
      'env.DATABASE_URL': 'a',
      'env.DELEGATE_WORKER_API_KEY': 'delegate-key',
    });
  });

  it.each([
    [{ ...FORM, azure: { ...AZURE, subscriptionId: 'prod' } }, /subscription id is a GUID/],
    [{ ...FORM, envValues: {} }, /Enter a value for DATABASE_URL/],
    [{ ...FORM, azureClientSecret: null }, /client secret/],
    [{ ...FORM, envNames: ['TOKEN_ENCRYPTION_KEY'] }, /cannot be handed to a sandbox/],
  ])(
    'refuses a setup that is not complete with a 400 and a sentence, storing nothing',
    async (body, message) => {
      const response = await PUT(request('PUT', body));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(message);
      expect(await storedRow()).toBeNull();
      expect(recordAuditEvent).not.toHaveBeenCalled();
    }
  );
});

describe('POST /api/admin/sandboxes/test-connection', () => {
  it('hands the orchestrator the setup about to be saved — typed secrets over stored ones — and answers what it said, storing nothing', async () => {
    await PUT(request('PUT', FORM));
    client.checkSandboxOrchestrator!.mockResolvedValue({
      ok: false,
      detail: 'AuthorizationFailed',
    });
    const response = await TEST(
      request(
        'POST',
        { ...FORM, azureClientSecret: null, azure: { ...AZURE, region: 'westus2' } },
        '/test-connection'
      )
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, detail: 'AuthorizationFailed' });
    expect(client.checkSandboxOrchestrator).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        azure: expect.objectContaining({ region: 'westus2' }),
      }),
      secrets: {
        azureClientSecret: 'client-s3cret',
        'env.DATABASE_URL': 'postgres://sandbox:pw@db/renkei',
      },
    });
    // The stored setup is as it was.
    expect((await storedRow())?.settings).toMatchObject({ azure: { region: 'eastus2' } });
  });

  it('says what is missing rather than trying a setup that could not be saved', async () => {
    const response = await TEST(request('POST', { ...FORM, envValues: {} }, '/test-connection'));
    expect(await response.json()).toEqual({ ok: false, detail: 'Enter a value for DATABASE_URL.' });
    expect(client.checkSandboxOrchestrator).not.toHaveBeenCalled();
  });
});
