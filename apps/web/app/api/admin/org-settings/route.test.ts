/**
 * The organization settings route (GET/PUT /api/admin/org-settings), on
 * the memory store: what the Settings page's one Save stores, what it
 * refuses with a 400, and what it clamps — the server answers the
 * organization-name, PHI covered-model, sandbox settings, approval-policy
 * and checkout-limit specs checked through a browser before
 * (settings-form.model.test.ts holds the form's own rules).
 */

jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@/lib/mcp-tools/tool-catalog', () => ({ invalidateToolCatalogCache: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { invalidateSettingsCache } from '@renkei/settings';
import { GET, PUT } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { recordAuditEvent: mockAudit } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);
const { invalidateToolCatalogCache: mockInvalidate } = jest.requireMock<{
  invalidateToolCatalogCache: jest.Mock;
}>('@/lib/mcp-tools/tool-catalog');

const GB = 1_073_741_824;
const MB = 1_048_576;

beforeEach(() => {
  jest.clearAllMocks();
  registerDataStore(createMemoryDataStore());
  invalidateSettingsCache();
  mockCheckAccess.mockResolvedValue({ subject: 'operator@example.com' });
});

afterEach(() => {
  resetDataStore();
  invalidateSettingsCache();
});

const put = (body: unknown) =>
  PUT(
    new NextRequest('http://test.local/api/admin/org-settings', {
      method: 'PUT',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

async function stored(): Promise<Record<string, unknown>> {
  const response = await GET(new NextRequest('http://test.local/api/admin/org-settings'));
  expect(response.status).toBe(200);
  const body: { settings: Record<string, unknown> } = await response.json();
  return body.settings;
}

async function answered(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  const body: { settings: Record<string, unknown> } = await response.json();
  return body.settings;
}

describe('GET/PUT /api/admin/org-settings', () => {
  it('is an operator’s: anyone else gets 401 and nothing is stored', async () => {
    mockCheckAccess.mockResolvedValue(null);
    expect((await GET(new NextRequest('http://test.local/x'))).status).toBe(401);
    expect((await put({ readOnly: true })).status).toBe(401);
    mockCheckAccess.mockResolvedValue({ subject: 'operator@example.com' });
    expect((await stored()).readOnly).toBe(false);
  });

  it('a fresh organization: named Renkei, PHI switch off, events-and-webhooks approval, 8 GB checkouts', async () => {
    const settings = await stored();
    expect(settings).toMatchObject({
      organizationName: 'Renkei',
      admanagerProductName: 'Renkei',
      phiConnectorsRequireCoveredModel: false,
      agentActStepsRequireApproval: 'externally_triggered',
      sandboxWorkspaceMaxBytes: 8 * GB,
      sandboxServiceMemoryBytes: 1 * GB,
      sandboxScriptMemoryBytes: 2 * GB,
      sandboxServicePids: 512,
    });
  });

  it('refuses a body that is not an object', async () => {
    expect((await put('[1]')).status).toBe(400);
    expect((await put('not json')).status).toBe(400);
  });

  describe('the organization’s names', () => {
    it('stores the name trimmed, and answers it', async () => {
      const settings = await answered(await put({ organizationName: '  Acme Health  ' }));
      expect(settings.organizationName).toBe('Acme Health');
      expect((await stored()).organizationName).toBe('Acme Health');
      expect(mockAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'settings.updated',
          details: { changed: { organizationName: { from: 'Renkei', to: 'Acme Health' } } },
        })
      );
    });

    it('takes a name, not a blank, and keeps the name it had', async () => {
      await put({ organizationName: 'Acme Health' });
      const refused = await put({ organizationName: '   ' });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'organizationName must be a name' });
      expect((await stored()).organizationName).toBe('Acme Health');
    });

    it('cuts a name past 80 characters', async () => {
      const settings = await answered(await put({ organizationName: 'A'.repeat(100) }));
      expect(settings.organizationName).toBe('A'.repeat(80));
    });

    it('stores the AD Manager product name the same way, and refuses a blank one', async () => {
      expect(
        (await answered(await put({ admanagerProductName: ' Renkei E2E ' }))).admanagerProductName
      ).toBe('Renkei E2E');
      expect((await put({ admanagerProductName: '' })).status).toBe(400);
      expect((await stored()).admanagerProductName).toBe('Renkei E2E');
    });
  });

  describe('switches', () => {
    it('the PHI covered-model switch saves and reads back, on and off again', async () => {
      await put({ phiConnectorsRequireCoveredModel: true });
      expect((await stored()).phiConnectorsRequireCoveredModel).toBe(true);
      await put({ phiConnectorsRequireCoveredModel: false });
      expect((await stored()).phiConnectorsRequireCoveredModel).toBe(false);
    });

    it('turning charts off changes that switch and leaves the other sandbox features on', async () => {
      await put({
        sandboxBrowserEnabled: true,
        sandboxChartsEnabled: true,
        sandboxWorkspacesEnabled: true,
      });
      const settings = await answered(await put({ sandboxChartsEnabled: false }));
      expect(settings.sandboxChartsEnabled).toBe(false);
      expect(settings.sandboxWorkspacesEnabled).toBe(true);
      expect(settings.sandboxBrowserEnabled).toBe(true);
    });

    it('takes only true or false, and stores nothing from a refused body', async () => {
      const refused = await put({ readOnly: true, sandboxScriptsEnabled: 'yes' });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: 'sandboxScriptsEnabled must be true or false',
      });
      expect((await stored()).readOnly).toBe(false);
    });

    it('read-only mode, and only it, refreshes the tool catalog', async () => {
      await put({ enableDcr: true });
      expect(mockInvalidate).not.toHaveBeenCalled();
      await put({ readOnly: true });
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
    });
  });

  describe('the approval policy', () => {
    it('stores a known policy and answers it', async () => {
      expect(
        (await answered(await put({ agentActStepsRequireApproval: 'all' })))
          .agentActStepsRequireApproval
      ).toBe('all');
      expect(
        (await answered(await put({ agentActStepsRequireApproval: 'off' })))
          .agentActStepsRequireApproval
      ).toBe('off');
      expect((await stored()).agentActStepsRequireApproval).toBe('off');
    });

    it('refuses a value outside the set', async () => {
      const refused = await put({ agentActStepsRequireApproval: 'sometimes' });
      expect(refused.status).toBe(400);
      expect((await stored()).agentActStepsRequireApproval).toBe('externally_triggered');
    });

    it('refuses an unknown log level', async () => {
      expect((await put({ logLevel: 'verbose' })).status).toBe(400);
      expect((await answered(await put({ logLevel: 'debug' }))).logLevel).toBe('debug');
    });
  });

  describe('numbers are clamped to their ranges, never stored as typed', () => {
    it('the service memory ceiling saves as sent, leaving the other sandbox limits alone', async () => {
      const settings = await answered(await put({ sandboxServiceMemoryBytes: 1536 * MB }));
      expect(settings.sandboxServiceMemoryBytes).toBe(1536 * MB);
      expect(settings.sandboxServicePids).toBe(512);
      expect(settings.sandboxScriptMemoryBytes).toBe(2 * GB);
    });

    it('a process limit below what a container runs in goes to the floor of 16', async () => {
      expect((await answered(await put({ sandboxServicePids: 1 }))).sandboxServicePids).toBe(16);
    });

    it('a checkout limit of 500 GB is stored as the 64 GB ceiling; 12 GB as asked', async () => {
      expect(
        (await answered(await put({ sandboxWorkspaceMaxBytes: 500 * GB }))).sandboxWorkspaceMaxBytes
      ).toBe(64 * GB);
      expect(
        (await answered(await put({ sandboxWorkspaceMaxBytes: 12 * GB }))).sandboxWorkspaceMaxBytes
      ).toBe(12 * GB);
    });

    it('a fraction is cut to a whole number', async () => {
      expect((await answered(await put({ agentMaxChainDepth: 4.7 }))).agentMaxChainDepth).toBe(4);
    });

    it('refuses a number that is not one', async () => {
      const refused = await put({ maxJqlResults: '50' });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'maxJqlResults must be a number' });
    });
  });

  it('a save that changes nothing writes nothing and audits nothing', async () => {
    const settings = await answered(await put({ organizationName: 'Renkei', readOnly: false }));
    expect(settings.organizationName).toBe('Renkei');
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
