/**
 * The organization's locked high-risk tools (GET/PUT
 * /api/admin/high-risk-tools), on the memory store: operators only, the
 * list replaced whole, names checked, and every change audited with what
 * was locked and unlocked.
 */

jest.mock('@/lib/access', () => ({ checkAccess: jest.fn(), ROLE_OPERATOR: 'renkei-operator' }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { NextRequest } from 'next/server';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { getOrgSettings, invalidateSettingsCache, setOrgSettings } from '@renkei/settings';
import { GET, PUT } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { recordAuditEvent: mockAudit } = jest.requireMock<{ recordAuditEvent: jest.Mock }>(
  '@/lib/audit-events'
);

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
    new NextRequest('http://test.local/api/admin/high-risk-tools', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  );

async function locked(): Promise<string[]> {
  const settings = await getOrgSettings();
  if (!settings.ok) throw new Error('settings unreadable');
  return settings.val.lockedHighRiskTools;
}

describe('GET/PUT /api/admin/high-risk-tools', () => {
  it('is an operator’s: anyone else gets 401 and nothing changes', async () => {
    mockCheckAccess.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await put({ tools: ['outlook_send_mail'] })).status).toBe(401);
    expect(await locked()).toEqual([]);
  });

  it('replaces the list whole, sorted and without repeats, and audits what moved', async () => {
    await setOrgSettings({ lockedHighRiskTools: ['jira_delete_issue', 'outlook_send_mail'] });
    const response = await put({
      tools: ['outlook_send_mail', 'github_merge_pull_request', 'outlook_send_mail'],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tools: ['github_merge_pull_request', 'outlook_send_mail'],
    });
    expect(await locked()).toEqual(['github_merge_pull_request', 'outlook_send_mail']);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.updated',
        details: {
          changed: {
            lockedHighRiskTools: {
              added: ['github_merge_pull_request'],
              removed: ['jira_delete_issue'],
            },
          },
        },
      })
    );
    expect(await (await GET()).json()).toEqual({
      tools: ['github_merge_pull_request', 'outlook_send_mail'],
    });
  });

  it('refuses what is not a list of tool names, and saves nothing', async () => {
    await setOrgSettings({ lockedHighRiskTools: ['outlook_send_mail'] });
    for (const body of [{}, { tools: 'outlook_send_mail' }, { tools: ['not a tool name'] }]) {
      expect((await put(body)).status).toBe(400);
    }
    expect(await locked()).toEqual(['outlook_send_mail']);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('saving the same list again records nothing', async () => {
    await setOrgSettings({ lockedHighRiskTools: ['outlook_send_mail'] });
    expect((await put({ tools: ['outlook_send_mail'] })).status).toBe(200);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
