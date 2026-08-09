/**
 * The sweep's contract: no stored public base URL means no sweep (never
 * register webhooks pointing somewhere wrong); each enabled tenant is
 * reconciled against its own derived target URL; one tenant's failure
 * doesn't stop the rest; repairs are logged loudly, health is silent.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/crypto', () => ({
  parseEncryptionKey: jest.fn(() => ({ ok: true, val: Buffer.alloc(32) })),
}));
jest.mock('@renkei/connector-config', () => ({
  readConnectorConfigCached: jest.fn(),
}));
jest.mock('@renkei/settings', () => ({
  getPublicBaseUrl: jest.fn(),
}));

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { WebexWebhook, WebexWebhooksClient } from '@renkei/connector-webex';
import { sweepWebexWebhooks } from './webex-webhooks';
import { logger } from '../logger';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { readConnectorConfigCached: mockReadConfig } = jest.requireMock<{
  readConnectorConfigCached: jest.Mock;
}>('@renkei/connector-config');
const { getPublicBaseUrl: mockGetPublicBaseUrl } = jest.requireMock<{
  getPublicBaseUrl: jest.Mock;
}>('@renkei/settings');

function stubDbTenants(tenantIds: string[]): void {
  const chain = {
    select: () => chain,
    where: () => chain,
    execute: async () => tenantIds.map((tenant_id) => ({ tenant_id })),
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: { selectFrom: () => chain } });
}

function configFor(secrets: Record<string, string>) {
  return { ok: true, val: { connector: 'webex', enabled: true, settings: {}, secrets } };
}

function activeHook(over: Partial<WebexWebhook>): WebexWebhook {
  return {
    id: 'hook-1',
    name: 'Renkei ingestion',
    targetUrl: '',
    resource: 'messages',
    event: 'created',
    secret: null,
    status: 'active',
    ...over,
  };
}

interface StubbedClient {
  client: WebexWebhooksClient;
  created: Array<Record<string, unknown>>;
}

function stubClient(hooks: WebexWebhook[]): StubbedClient {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    client: {
      listWebhooks: async () => ok(hooks),
      createWebhook: async (registration) => {
        created.push({ ...registration });
        return ok(activeHook({ id: `new-${created.length}`, ...registration }));
      },
      deleteWebhook: async () => ok(),
    },
  };
}

beforeEach(() => {
  mockGetDatabase.mockReset();
  mockReadConfig.mockReset();
  mockGetPublicBaseUrl.mockReset();
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  jest.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('sweepWebexWebhooks', () => {
  it('skips entirely when no public base URL is stored', async () => {
    mockGetPublicBaseUrl.mockReturnValue(null);
    const makeClient = jest.fn();

    await sweepWebexWebhooks({ makeClient });

    expect(makeClient).not.toHaveBeenCalled();
    expect(mockGetDatabase).not.toHaveBeenCalled();
  });

  it('registers both webhooks for a tenant that has none, at the derived target', async () => {
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    stubDbTenants(['tenant-1']);
    mockReadConfig.mockResolvedValue(configFor({ botToken: 'token-1', webhookSecret: 'secret-1' }));
    const stub = stubClient([]);

    await sweepWebexWebhooks({ makeClient: () => stub.client });

    expect(stub.created).toHaveLength(2);
    expect(
      stub.created.every(
        (c) => c.targetUrl === 'https://renkei.example.com/api/webhooks/webex/tenant-1'
      )
    ).toBe(true);
    expect(stub.created.every((c) => c.secret === 'secret-1')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('repaired webhooks'),
      expect.objectContaining({ tenantId: 'tenant-1' })
    );
  });

  it('stays silent for a tenant whose webhooks are healthy', async () => {
    const target = 'https://renkei.example.com/api/webhooks/webex/tenant-1';
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    stubDbTenants(['tenant-1']);
    mockReadConfig.mockResolvedValue(configFor({ botToken: 'token-1', webhookSecret: 'secret-1' }));
    const stub = stubClient([
      activeHook({ id: 'a', targetUrl: target }),
      activeHook({ id: 'b', targetUrl: target, resource: 'attachmentActions' }),
    ]);

    await sweepWebexWebhooks({ makeClient: () => stub.client });

    expect(stub.created).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('continues to the next tenant when one tenant’s WebEx API fails', async () => {
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    stubDbTenants(['tenant-1', 'tenant-2']);
    mockReadConfig.mockResolvedValue(configFor({ botToken: 'token', webhookSecret: 'secret' }));
    const failing: WebexWebhooksClient = {
      listWebhooks: async () => err('WEBEX_API_ERROR' as const),
      createWebhook: async () => err('WEBEX_API_ERROR' as const),
      deleteWebhook: async () => err('WEBEX_API_ERROR' as const),
    };
    const healthy = stubClient([]);
    let call = 0;
    const makeClient = () => (call++ === 0 ? failing : healthy.client);

    await sweepWebexWebhooks({ makeClient });

    expect(healthy.created).toHaveLength(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: 'tenant-1' })
    );
  });

  it('skips a tenant whose config lost its secrets, with a warning', async () => {
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    stubDbTenants(['tenant-1']);
    mockReadConfig.mockResolvedValue(configFor({ botToken: 'token-only' }));
    const makeClient = jest.fn();

    await sweepWebexWebhooks({ makeClient });

    expect(makeClient).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('missing bot token or webhook secret'),
      expect.objectContaining({ tenantId: 'tenant-1' })
    );
  });
});
