/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The sweep's contract, user-webhook edition: no stored public base URL
 * means no sweep (never register webhooks pointing somewhere wrong); each
 * opted-in grant is reconciled against its own per-user target with its
 * own per-grant secret; one grant's dead token doesn't stop the rest;
 * repairs are logged loudly, health is silent.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
// The sweep only uses kysely's sql tag inside a .where()/.set(); the stub
// chain ignores its argument, so a fragment marker suffices (kysely itself
// is ESM this jest config does not transform).
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));
jest.mock('@renkei/settings', () => ({ getPublicBaseUrl: jest.fn(), getOrgSettings: jest.fn() }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ok } from '@campfhir/safe-functions/helpers';
import type { WebexWebhook, WebexWebhooksClient } from '@renkei/connector-webex';
import { sweepWebexWebhooks } from './webex-webhooks';
import { logger } from '../logger';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { getPublicBaseUrl: mockGetPublicBaseUrl, getOrgSettings: mockGetOrgSettings } =
  jest.requireMock<{
    getPublicBaseUrl: jest.Mock;
    getOrgSettings: jest.Mock;
  }>('@renkei/settings');

interface GrantRow {
  tenant_id: string;
  provider_account_id: string;
  metadata: unknown;
}

function dbWithGrants(rows: GrantRow[]) {
  const updates: Array<{ tenant_id: string; provider_account_id: string }> = [];
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            where: () => ({ execute: async () => rows }),
          }),
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: (_column: string, _op: string, tenantId: string) => ({
            where: () => ({
              where: (_c: string, _o: string, accountId: string) => ({
                execute: async () => {
                  updates.push({ tenant_id: tenantId, provider_account_id: accountId });
                },
              }),
            }),
          }),
        }),
      }),
    },
  });
  return updates;
}

function healthyHook(targetUrl: string, secret: string): WebexWebhook {
  return {
    id: 'hook-1',
    name: 'Renkei all spaces',
    targetUrl,
    resource: 'messages',
    event: 'created',
    secret,
    status: 'active',
    createdBy: null,
  } as unknown as WebexWebhook;
}

function stubClient(hooks: WebexWebhook[]) {
  const created: Array<Record<string, unknown>> = [];
  const client: WebexWebhooksClient = {
    listWebhooks: async () => ok(hooks),
    createWebhook: async (registration) => {
      created.push({ ...registration });
      return ok(healthyHook(String(registration.targetUrl), String(registration.secret)));
    },
    deleteWebhook: async () => ok(),
  };
  return { client, created };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrgSettings.mockResolvedValue({ ok: true, val: { webexWebhookHealthMinutes: 60 } });
});

describe('sweepWebexWebhooks', () => {
  const grant: GrantRow = {
    tenant_id: 'tenant-1',
    provider_account_id: 'acct-1',
    metadata: { allSpaces: true, allSpacesSecret: 'secret-1' },
  };
  const TARGET = 'https://renkei.example.com/api/webhooks/webex/tenant-1/user/acct-1';

  it('skips entirely with no public base URL — never a wrong-target registration', async () => {
    mockGetPublicBaseUrl.mockReturnValue(null);
    const resolveAccess = jest.fn();
    await sweepWebexWebhooks({ resolveAccess });
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it('reconciles an opted-in grant against its own per-user target', async () => {
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    dbWithGrants([grant]);
    const { client, created } = stubClient([]);

    await sweepWebexWebhooks({
      makeClient: () => client,
      resolveAccess: async () => ({ accessToken: 'user-token', subject: 'subj-1' }),
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ targetUrl: TARGET, secret: 'secret-1' });
    // A repair is loud: events were being lost until now.
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is silent when the registration is already healthy', async () => {
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    dbWithGrants([grant]);
    const { client, created } = stubClient([healthyHook(TARGET, 'secret-1')]);

    await sweepWebexWebhooks({
      makeClient: () => client,
      resolveAccess: async () => ({ accessToken: 'user-token', subject: 'subj-1' }),
    });

    expect(created).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips a grant whose token cannot be resolved without stopping the rest', async () => {
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    dbWithGrants([{ ...grant, provider_account_id: 'acct-dead' }, grant]);
    const { client, created } = stubClient([]);

    await sweepWebexWebhooks({
      makeClient: () => client,
      resolveAccess: async (_tenantId, accountId) =>
        accountId === 'acct-dead' ? null : { accessToken: 'user-token', subject: 'subj-1' },
    });

    // The dead grant registered nothing; the live one still got repaired.
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ targetUrl: TARGET });
  });

  it('skips a grant checked more recently than the org due-time — no API call, no rewrite', async () => {
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    mockGetOrgSettings.mockResolvedValue({ ok: true, val: { webexWebhookHealthMinutes: 60 } });
    const now = new Date('2026-01-01T01:00:00.000Z');
    const checkedRecently: GrantRow = {
      ...grant,
      metadata: {
        ...(grant.metadata as object),
        webhookHealthCheckedAt: '2026-01-01T00:30:00.000Z',
      },
    };
    const updates = dbWithGrants([checkedRecently]);
    const { client, created } = stubClient([]);
    const resolveAccess = jest.fn();

    await sweepWebexWebhooks({ makeClient: () => client, resolveAccess, now: () => now });

    expect(resolveAccess).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('rechecks a grant once the org due-time has passed, then records the check', async () => {
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    mockGetOrgSettings.mockResolvedValue({ ok: true, val: { webexWebhookHealthMinutes: 15 } });
    const now = new Date('2026-01-01T01:00:00.000Z');
    const staleCheck: GrantRow = {
      ...grant,
      metadata: {
        ...(grant.metadata as object),
        webhookHealthCheckedAt: '2026-01-01T00:30:00.000Z',
      },
    };
    const updates = dbWithGrants([staleCheck]);
    const { client, created } = stubClient([]);

    await sweepWebexWebhooks({
      makeClient: () => client,
      resolveAccess: async () => ({ accessToken: 'user-token', subject: 'subj-1' }),
      now: () => now,
    });

    expect(created).toHaveLength(1);
    expect(updates).toEqual([{ tenant_id: 'tenant-1', provider_account_id: 'acct-1' }]);
  });

  it('records the check time even when the API call fails, so a 429 backs off instead of retrying every wake', async () => {
    mockGetPublicBaseUrl.mockReturnValue('https://renkei.example.com');
    mockGetOrgSettings.mockResolvedValue({ ok: true, val: { webexWebhookHealthMinutes: 60 } });
    const updates = dbWithGrants([grant]);
    const client: WebexWebhooksClient = {
      listWebhooks: async () => ({
        ok: false,
        err: { type: 'WEBEX_API_ERROR', message: 'WebEx API 429' },
      }),
      createWebhook: async () => {
        throw new Error('should not be called');
      },
      deleteWebhook: async () => ok(),
    };

    await sweepWebexWebhooks({
      makeClient: () => client,
      resolveAccess: async () => ({ accessToken: 'user-token', subject: 'subj-1' }),
    });

    expect(updates).toEqual([{ tenant_id: 'tenant-1', provider_account_id: 'acct-1' }]);
    expect(logger.error).toHaveBeenCalled();
  });
});
