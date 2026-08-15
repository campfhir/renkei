/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * `oauthJsmOpsAuth` in isolation — the base URL it builds, and the scope
 * gate it wraps every call in.
 *
 * ops.test.ts stubs this interface entirely, because it's testing the
 * TOOLS' rendering and wizard logic and has no reason to care how auth
 * works. This file is the other half: proving the concrete production
 * implementation actually does what JsmOpsAuth promises, so the split
 * between "the tools" and "how they authenticate" (ops-auth.ts) doesn't
 * quietly lose coverage of the second half.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
// See ops.test.ts's identical comment: withPresentationHint isn't used here,
// but importing ops-auth.ts pulls in jiraFetch from ../common, which
// transitively imports @renkei/db → kysely (ESM, unparseable under this
// suite's CJS runtime) for exports this file never touches.
jest.mock('../common', () => ({
  jiraFetch: (...args: unknown[]) => mockJiraFetch(...args),
}));

const mockJiraFetch = jest.fn();

import { oauthJsmOpsAuth, opsScopes } from './ops-auth';
import type { MCPToolContext } from '../common';

const context = (overrides: Partial<MCPToolContext> = {}): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    cloudId: 'cloud-1',
    accessToken: 'token-1',
    siteUrl: '',
    apiBaseUrl: '',
    maxJqlResults: 100,
    ...overrides,
  }) as unknown as MCPToolContext;

beforeEach(() => {
  jest.clearAllMocks();
  mockJiraFetch.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('oauthJsmOpsAuth — availability', () => {
  it('is unavailable with no cloud id on the connection', () => {
    const auth = oauthJsmOpsAuth(context({ cloudId: undefined }));
    expect(auth.unavailableReason()).toBe('No Atlassian cloud id on this connection.');
  });

  it('is available once a cloud id is present', () => {
    const auth = oauthJsmOpsAuth(context());
    expect(auth.unavailableReason()).toBeNull();
  });
});

describe('oauthJsmOpsAuth — base URL', () => {
  it('builds the OAuth GATEWAY path, never the bare Ops base', async () => {
    // The one thing this whole abstraction exists to get right: a 3LO
    // Bearer token only works through /ex/jira/{cloudId}/jsm/ops/... — the
    // bare /jsm/ops/api/{cloudId}/... base 401s it with no hint the URL was
    // the problem. Regressing this line is exactly the bug that shipped
    // once already, just moved one layer down.
    const auth = oauthJsmOpsAuth(context({ cloudId: 'cloud-42' }));

    await auth.fetch([], '/schedules?expand=rotation');

    expect(mockJiraFetch).toHaveBeenCalledWith(
      'https://api.atlassian.com/ex/jira/cloud-42/jsm/ops/api/v1/schedules?expand=rotation',
      'token-1',
      undefined
    );
  });

  it('forwards the method and body untouched', async () => {
    const auth = oauthJsmOpsAuth(context());
    const init = { method: 'PATCH', body: JSON.stringify({ name: 'x' }) };

    await auth.fetch([], '/schedules/s-1/rotations/r-1', init);

    expect(mockJiraFetch).toHaveBeenCalledWith(expect.any(String), 'token-1', init);
  });
});

describe('oauthJsmOpsAuth — the call-time scope gate', () => {
  it('refuses a call the grant does not cover, without touching the network', async () => {
    const auth = oauthJsmOpsAuth(
      context({ grantedScopes: ['read:ops-alert:jira-service-management'] })
    );

    const response = await auth.fetch(
      ['write:ops-config:jira-service-management'],
      '/schedules/s-1/rotations/r-1',
      { method: 'PATCH' }
    );

    expect(response.ok).toBe(false);
    expect(mockJiraFetch).not.toHaveBeenCalled();
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('write:ops-config:jira-service-management');
  });

  it('allows a call the grant does cover', async () => {
    const auth = oauthJsmOpsAuth(
      context({ grantedScopes: ['read:ops-config:jira-service-management'] })
    );

    const response = await auth.fetch(['read:ops-config:jira-service-management'], '/schedules');

    expect(response.ok).toBe(true);
    expect(mockJiraFetch).toHaveBeenCalledTimes(1);
  });

  it('allows everything when grantedScopes is undefined', async () => {
    // A grant recorded before scopes were is what undefined means here — see
    // withScopeGate in capability-gate.ts, which registers every tool for
    // exactly this case. The call-time gate has to agree, or a tool that
    // registered fine would still fail every call it makes.
    const auth = oauthJsmOpsAuth(context({ grantedScopes: undefined }));

    const response = await auth.fetch(
      ['write:ops-config:jira-service-management', 'delete:ops-config:jira-service-management'],
      '/schedules/s-1'
    );

    expect(response.ok).toBe(true);
    expect(mockJiraFetch).toHaveBeenCalledTimes(1);
  });
});

describe('opsScopes — the single source of truth index.ts and ops.ts share', () => {
  it('routes alert tools to the alert scope family', () => {
    expect(opsScopes('jsm_ops_list_alerts', true)).toEqual([
      'read:ops-alert:jira-service-management',
    ]);
    expect(opsScopes('jsm_ops_acknowledge_alert', false)).toEqual([
      'read:ops-alert:jira-service-management',
      'write:ops-alert:jira-service-management',
    ]);
  });

  it('routes everything else to the config scope family', () => {
    expect(opsScopes('jsm_ops_list_schedules', true)).toEqual([
      'read:ops-config:jira-service-management',
    ]);
    expect(opsScopes('jsm_ops_update_rotation', false)).toEqual([
      'read:ops-config:jira-service-management',
      'write:ops-config:jira-service-management',
    ]);
  });

  it('gives delete_override the delete scope, not write', () => {
    // The one tool that does not follow the readOnly → WRITE pattern: it
    // deletes, so it needs the DELETE scope alongside READ, never WRITE.
    expect(opsScopes('jsm_ops_delete_override', false)).toEqual([
      'read:ops-config:jira-service-management',
      'delete:ops-config:jira-service-management',
    ]);
  });
});
