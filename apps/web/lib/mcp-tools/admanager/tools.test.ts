/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The admanager tools' contract at the model boundary: per-instance
 * LLM-exposure gates (a tool registers only when some connected instance
 * grants its permission), the preview/confirm cards for every write, the
 * additive-only group-membership semantics (never a guess at removing a
 * group the account was never in), and the mapping of worker/upstream
 * refusals onto model-readable messages.
 */

jest.mock('@/lib/admanager/service-client', () => ({
  admanagerApi: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { ADMANAGER_PERMISSION_IDS } from '@renkei/connector-admanager';
import type { AdManagerPermission, InstanceConnection } from '@renkei/connector-admanager';
import { registerAdManagerTools, type AdManagerToolExposure } from './index';
import { NO_SUCH_INSTANCE } from './admanager-auth';
import type { AdManagerAuth } from './admanager-auth';
import type { MCPToolContext } from '../common';

const { admanagerApi } = jest.requireMock<{ admanagerApi: jest.Mock }>(
  '@/lib/admanager/service-client'
);

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

const INSTANCE_ID = '11111111-2222-3333-4444-555555555555';

function contextOf(): MCPToolContext {
  return { tenantId: 'tenant-1', subject: 'auth0|alice' } as unknown as MCPToolContext;
}

const ALL: AdManagerPermission[] = [...ADMANAGER_PERMISSION_IDS];

function connectionOf(permissions: AdManagerPermission[] = ALL): InstanceConnection {
  return { technicianName: 'alice', permissions };
}

function authOf(connection: InstanceConnection): AdManagerAuth {
  return {
    kind: 'user',
    target() {
      return { tenantId: 'tenant-1', subject: 'auth0|alice' };
    },
    async listConnected() {
      return [
        {
          instance: {
            id: INSTANCE_ID,
            name: 'Prod',
            environment: 'prod',
            baseUrl: 'https://admp.example:8080',
            tlsVerify: true,
            hasCustomCa: false,
            allowInsecureHttp: false,
            enabled: true,
          },
          connection,
        },
      ];
    },
    async connection(instanceId: string) {
      if (instanceId !== INSTANCE_ID) return NO_SUCH_INSTANCE;
      return connection;
    },
  };
}

function register(
  connection: InstanceConnection = connectionOf(),
  exposure: AdManagerToolExposure = { permissions: connection.permissions }
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerAdManagerTools(server, contextOf(), authOf(connection), exposure);
  return handlers;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

const answer = (status: number, body: unknown) => ({
  ok: true as const,
  val: { status, contentType: 'application/json', body: JSON.stringify(body) },
});

const usersResponse = (rows: Record<string, unknown>[]) => answer(200, { data: rows, meta: {} });

beforeEach(() => {
  admanagerApi.mockReset();
});

describe('registration gating', () => {
  it('registers accounts.read tools only when granted', () => {
    const withRead = register(connectionOf(['accounts.read']));
    expect(withRead.has('admanager_get_user')).toBe(true);
    expect(withRead.has('admanager_search_users')).toBe(true);

    const withoutRead = register(connectionOf(['accounts.unlock']));
    expect(withoutRead.has('admanager_get_user')).toBe(false);
    expect(withoutRead.has('admanager_search_users')).toBe(false);
  });

  it('always registers admanager_list_instances', () => {
    const handlers = register(connectionOf([]));
    expect(handlers.has('admanager_list_instances')).toBe(true);
  });

  it('gates unlock, reset-password, create, edit and group tools independently', () => {
    const handlers = register(connectionOf(['accounts.unlock']));
    expect(handlers.has('admanager_unlock_account_preview')).toBe(true);
    expect(handlers.has('admanager_reset_password_preview')).toBe(false);
    expect(handlers.has('admanager_create_user_preview')).toBe(false);
    expect(handlers.has('admanager_update_user_preview')).toBe(false);
    expect(handlers.has('admanager_add_user_to_groups_preview')).toBe(false);
  });

  it('re-checks the permission on the instance named, per call, even if registered', async () => {
    // Registered because SOME instance grants it, but this call's own
    // connection lookup only ever sees the one instance in this test
    // harness, so simulate a narrower per-call exposure by using a
    // connection with the tool's permission removed.
    const handlers = register(connectionOf([]), { permissions: ['accounts.unlock'] });
    const result = await handlers.get('admanager_unlock_account_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does not grant/);
  });
});

describe('admanager_get_user', () => {
  it('formats the user record, including groups from MEMBER_OF DNs', async () => {
    admanagerApi.mockResolvedValueOnce(
      usersResponse([
        {
          SAM_ACCOUNT_NAME: 'jdoe',
          DISPLAY_NAME: 'Jane Doe',
          ACCOUNT_STATUS: 'Locked',
          EMAIL_ADDRESS: 'jane@corp.example',
          MEMBER_OF: ['CN=VPN Users,OU=Groups,DC=corp,DC=example'],
        },
      ])
    );
    const handlers = register(connectionOf(['accounts.read']));
    const result = await handlers.get('admanager_get_user')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    expect(textOf(result)).toContain('Jane Doe');
    expect(textOf(result)).toContain('Status: Locked');
    expect(textOf(result)).toContain('Groups: VPN Users');
  });

  it('never requests TELEPHONE_NUMBER or DESCRIPTION — ADManager Plus rejects both as invalid fields columns', async () => {
    admanagerApi.mockResolvedValueOnce(usersResponse([{ SAM_ACCOUNT_NAME: 'jdoe' }]));
    const handlers = register(connectionOf(['accounts.read']));
    await handlers.get('admanager_get_user')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    const fields = String(
      (admanagerApi.mock.calls[0]?.[1] as { query?: { fields?: string } } | undefined)?.query?.fields
    );
    expect(fields).not.toMatch(/TELEPHONE_NUMBER|DESCRIPTION/);
    expect(fields).toMatch(/EMPLOYEE_ID/);
  });

  it('shows Employee ID when AD has one, and omits the line when it does not', async () => {
    admanagerApi.mockResolvedValueOnce(
      usersResponse([{ SAM_ACCOUNT_NAME: 'jdoe', DISPLAY_NAME: 'Jane Doe', EMPLOYEE_ID: 'E12345' }])
    );
    const handlers = register(connectionOf(['accounts.read']));
    const withId = await handlers.get('admanager_get_user')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    expect(textOf(withId)).toContain('Employee ID: E12345');

    admanagerApi.mockResolvedValueOnce(usersResponse([{ SAM_ACCOUNT_NAME: 'svc-backup', DISPLAY_NAME: 'svc-backup' }]));
    const withoutId = await handlers.get('admanager_get_user')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'svc-backup',
    });
    expect(textOf(withoutId)).not.toContain('Employee ID');
  });

  it('answers a clear error when no user matches', async () => {
    admanagerApi.mockResolvedValueOnce(usersResponse([]));
    const handlers = register(connectionOf(['accounts.read']));
    const result = await handlers.get('admanager_get_user')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'nobody',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No user "nobody" was found/);
  });
});

describe('unlock account: preview + confirm', () => {
  it('preview builds a directory_action card, identifying the person, with the confirm tool and args', async () => {
    admanagerApi.mockResolvedValueOnce(
      usersResponse([{ DISPLAY_NAME: 'Jane Doe', ACCOUNT_STATUS: 'Locked' }])
    );
    const handlers = register();
    const result = await handlers.get('admanager_unlock_account_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    expect(result.structuredContent?.kind).toBe('directory_action');
    expect(result.structuredContent?.action).toBe('Unlock account');
    expect(
      (result.structuredContent?.person as Record<string, unknown>).name
    ).toBe('Jane Doe');
    expect(result.structuredContent?.confirmTool).toBe('admanager_unlock_account_confirm');
    expect(
      (result.structuredContent?.confirmArgs as Record<string, unknown>).samAccountName
    ).toBe('jdoe');
  });

  it('confirm posts to /RestAPI/UnlockUser with inputFormat and reports success', async () => {
    admanagerApi.mockResolvedValueOnce(answer(200, [{ status: '1', statusMessage: 'Unlocked.' }]));
    const handlers = register();
    const result = await handlers.get('admanager_unlock_account_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    expect(textOf(result)).toMatch(/Unlocked jdoe/);
    expect(admanagerApi).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', subject: 'auth0|alice', instanceId: INSTANCE_ID },
      expect.objectContaining({
        method: 'POST',
        path: '/RestAPI/UnlockUser',
        query: { domainName: 'corp.example', inputFormat: JSON.stringify([{ sAMAccountName: 'jdoe' }]) },
      })
    );
  });

  it('confirm treats a logical failure (HTTP 200, error envelope) as an error', async () => {
    admanagerApi.mockResolvedValueOnce(answer(200, { SEVERITY: 'FAILURE', STATUS_MESSAGE: 'No such user' }));
    const handlers = register();
    const result = await handlers.get('admanager_unlock_account_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No such user/);
  });

  it('phrases a permission-scope refusal from ADManager Plus itself (403)', async () => {
    admanagerApi.mockResolvedValueOnce(answer(403, { errorCode: 'ADM-4031' }));
    const handlers = register();
    const result = await handlers.get('admanager_unlock_account_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/token's scope does not permit/);
  });
});

describe('reset password: the shown password is the one used', () => {
  it('preview generates a password once and carries it in confirmArgs', async () => {
    admanagerApi.mockResolvedValueOnce(usersResponse([{ DISPLAY_NAME: 'Jane Doe' }]));
    const handlers = register();
    const result = await handlers.get('admanager_reset_password_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      resetPasswordTemplateName: 'Reset Password Template',
    });
    const confirmArgs = result.structuredContent?.confirmArgs as Record<string, unknown>;
    const secret = result.structuredContent?.secret as { label: string; value: string };
    expect(secret.label).toBe('New password');
    expect(confirmArgs.newPassword).toBe(secret.value);
    expect(typeof confirmArgs.newPassword).toBe('string');
    expect((confirmArgs.newPassword as string).length).toBeGreaterThanOrEqual(16);
  });

  it('preview refuses when forcing a change is requested with no template', async () => {
    const handlers = register();
    const result = await handlers.get('admanager_reset_password_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/resetPasswordTemplateName/);
    expect(admanagerApi).not.toHaveBeenCalled();
  });

  it('confirm resets via /RestAPI/ResetPwd then forces the change via /RestAPI/ModifyUser, keyed by sAMAccountName', async () => {
    admanagerApi
      .mockResolvedValueOnce(answer(200, [{ status: '1', statusMessage: 'Password Reset Successful.' }]))
      .mockResolvedValueOnce(answer(200, [{ status: '1', statusMessage: 'Successfully modified.' }]));
    const handlers = register();
    const result = await handlers.get('admanager_reset_password_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      newPassword: 'Sup3r!Secret9000',
      mustChangePassword: true,
      resetPasswordTemplateName: 'Reset Password Template',
    });
    expect(textOf(result)).toContain('Sup3r!Secret9000');
    expect(admanagerApi).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        method: 'POST',
        path: '/RestAPI/ResetPwd',
        query: {
          domainName: 'corp.example',
          passwordType: 'password',
          pwd: 'Sup3r!Secret9000',
          inputFormat: JSON.stringify([{ sAMAccountName: 'jdoe' }]),
        },
      })
    );
    expect(admanagerApi).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        method: 'POST',
        path: '/RestAPI/ModifyUser',
        query: {
          inputFormat: JSON.stringify([
            { sAMAccountName: 'jdoe', templateName: 'Reset Password Template' },
          ]),
        },
      })
    );
  });

  it('confirm refuses to force a change at next logon without a template', async () => {
    const handlers = register();
    const result = await handlers.get('admanager_reset_password_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      newPassword: 'Sup3r!Secret9000',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/resetPasswordTemplateName/);
    expect(admanagerApi).not.toHaveBeenCalled();
  });

  it('confirm resets without forcing a change when mustChangePassword is false', async () => {
    admanagerApi.mockResolvedValueOnce(answer(200, [{ status: '1', statusMessage: 'Password Reset Successful.' }]));
    const handlers = register();
    const result = await handlers.get('admanager_reset_password_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      newPassword: 'Sup3r!Secret9000',
      mustChangePassword: false,
    });
    expect(textOf(result)).toContain('Sup3r!Secret9000');
    expect(admanagerApi).toHaveBeenCalledTimes(1);
  });
});

describe('group membership is additive only', () => {
  it('add preview shows requested groups and flags ones already held', async () => {
    admanagerApi.mockResolvedValueOnce(
      usersResponse([
        {
          DISPLAY_NAME: 'Jane Doe',
          MEMBER_OF: ['CN=VPN Users,OU=Groups,DC=corp,DC=example'],
        },
      ])
    );
    const handlers = register();
    const result = await handlers.get('admanager_add_user_to_groups_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      groupNames: ['VPN Users', 'Finance-ReadOnly'],
    });
    const lists = result.structuredContent?.groupLists as { label: string; groups: string[] }[];
    expect(lists.find((list) => list.label === 'Groups to add')?.groups).toEqual([
      'VPN Users',
      'Finance-ReadOnly',
    ]);
    expect(lists.find((list) => list.label === 'Already a member of')?.groups).toEqual([
      'VPN Users',
    ]);
  });

  it('remove preview only ever offers groups the account actually has', async () => {
    admanagerApi.mockResolvedValueOnce(
      usersResponse([
        { DISPLAY_NAME: 'Jane Doe', MEMBER_OF: ['CN=VPN Users,OU=Groups,DC=corp,DC=example'] },
      ])
    );
    const handlers = register();
    const result = await handlers.get('admanager_remove_user_from_groups_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      groupNames: ['VPN Users', 'Never-A-Member'],
    });
    const confirmArgs = result.structuredContent?.confirmArgs as Record<string, unknown>;
    expect(confirmArgs.groupNames).toEqual(['VPN Users']);
  });

  it('remove preview short-circuits with plain text when nothing is held', async () => {
    admanagerApi.mockResolvedValueOnce(usersResponse([{ DISPLAY_NAME: 'Jane Doe', MEMBER_OF: [] }]));
    const handlers = register();
    const result = await handlers.get('admanager_remove_user_from_groups_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      groupNames: ['Finance-ReadOnly'],
    });
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toMatch(/not a member of any/);
  });

  it('copy-group-membership preview delegates confirm to admanager_add_user_to_groups_confirm', async () => {
    admanagerApi
      .mockResolvedValueOnce(
        usersResponse([
          {
            DISPLAY_NAME: 'Source User',
            MEMBER_OF: [
              'CN=VPN Users,OU=Groups,DC=corp,DC=example',
              'CN=Finance-ReadOnly,OU=Groups,DC=corp,DC=example',
            ],
          },
        ])
      )
      .mockResolvedValueOnce(
        usersResponse([
          { DISPLAY_NAME: 'Target User', MEMBER_OF: ['CN=VPN Users,OU=Groups,DC=corp,DC=example'] },
        ])
      );
    const handlers = register();
    const result = await handlers.get('admanager_copy_group_membership_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      sourceSamAccountName: 'source',
      targetSamAccountName: 'target',
    });
    expect(result.structuredContent?.confirmTool).toBe('admanager_add_user_to_groups_confirm');
    const confirmArgs = result.structuredContent?.confirmArgs as Record<string, unknown>;
    expect(confirmArgs.samAccountName).toBe('target');
    expect(confirmArgs.groupNames).toEqual(['Finance-ReadOnly']);
  });

  it('copy-group-membership answers plainly when the target already has everything', async () => {
    admanagerApi
      .mockResolvedValueOnce(
        usersResponse([
          { DISPLAY_NAME: 'Source User', MEMBER_OF: ['CN=VPN Users,OU=Groups,DC=corp,DC=example'] },
        ])
      )
      .mockResolvedValueOnce(
        usersResponse([
          { DISPLAY_NAME: 'Target User', MEMBER_OF: ['CN=VPN Users,OU=Groups,DC=corp,DC=example'] },
        ])
      );
    const handlers = register();
    const result = await handlers.get('admanager_copy_group_membership_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      sourceSamAccountName: 'source',
      targetSamAccountName: 'target',
    });
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toMatch(/already has every group/);
  });
});

describe('group membership: confirm PATCHes the two dedicated attribute keys', () => {
  it('add confirm PATCHes memberOf with the given template and reports success', async () => {
    admanagerApi.mockResolvedValueOnce(
      answer(200, { data: [{ status: { status_code: 1, status_message: 'Successfully modified.' } }] })
    );
    const handlers = register();
    const result = await handlers.get('admanager_add_user_to_groups_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      groupNames: ['VPN Users'],
      templateName: 'AD Update Template',
    });
    expect(textOf(result)).toMatch(/Added jdoe to: VPN Users/);
    expect(admanagerApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'PATCH',
        path: '/api/v2/users',
        query: { domain: 'corp.example', filter: '(SAM_ACCOUNT_NAME eq "jdoe")' },
        body: {
          template: { template_name: 'AD Update Template' },
          data: { attributes: { memberOf: 'VPN Users' } },
        },
      })
    );
  });

  it('remove confirm PATCHes removememberOf, never memberOf', async () => {
    admanagerApi.mockResolvedValueOnce(
      answer(200, { data: [{ status: { status_code: 1, status_message: 'Successfully modified.' } }] })
    );
    const handlers = register();
    const result = await handlers.get('admanager_remove_user_from_groups_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      groupNames: ['VPN Users'],
      templateName: 'AD Update Template',
    });
    expect(textOf(result)).toMatch(/Removed jdoe from: VPN Users/);
    expect(admanagerApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'PATCH',
        path: '/api/v2/users',
        body: {
          template: { template_name: 'AD Update Template' },
          data: { attributes: { removememberOf: 'VPN Users' } },
        },
      })
    );
  });

  it('surfaces a request-level ManageEngine rejection (IAM_ERROR_STATUS)', async () => {
    admanagerApi.mockResolvedValueOnce(answer(200, { IAM_ERROR_STATUS: true, eSTATUS: 'Template not found' }));
    const handlers = register();
    const result = await handlers.get('admanager_add_user_to_groups_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      groupNames: ['VPN Users'],
      templateName: 'AD Update Template',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Template not found/);
  });

  it('surfaces a per-item failure (status_code != 1) even though the HTTP call succeeded', async () => {
    admanagerApi.mockResolvedValueOnce(
      answer(200, { data: [{ status: { status_code: 0, status_message: 'No such group' } }] })
    );
    const handlers = register();
    const result = await handlers.get('admanager_add_user_to_groups_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      groupNames: ['Nonexistent Group'],
      templateName: 'AD Update Template',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No such group/);
  });
});

describe('create user: /RestAPI/CreateUser', () => {
  it('confirm sends a flat inputFormat entry and reports the password on success', async () => {
    admanagerApi.mockResolvedValueOnce(
      answer(200, [{ status: 'SUCCESS', USER_EMAIL: 'jdoe@corp.example', 'SAM Account Name': 'jdoe' }])
    );
    const handlers = register();
    const result = await handlers.get('admanager_create_user_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      ouPath: 'OU=Users,DC=corp,DC=example',
      firstName: 'Jane',
      lastName: 'Doe',
      sAMAccountName: 'jdoe',
      userPrincipalName: 'jdoe@corp.example',
      password: 'Sup3r!Secret9000',
      templateName: 'AD Create Template',
    });
    expect(textOf(result)).toMatch(/Created jdoe in corp.example/);
    expect(textOf(result)).toContain('Sup3r!Secret9000');
    expect(admanagerApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        method: 'POST',
        path: '/RestAPI/CreateUser',
        query: {
          domainName: 'corp.example',
          inputFormat: JSON.stringify([
            {
              sAMAccountName: 'jdoe',
              givenName: 'Jane',
              sn: 'Doe',
              name: 'Jane Doe',
              userPrincipalName: 'jdoe@corp.example',
              OUName: 'OU=Users,DC=corp,DC=example',
              password: 'Sup3r!Secret9000',
              templateName: 'AD Create Template',
            },
          ]),
        },
      })
    );
  });

  it('reports a request-level failure (no success entry) as an error', async () => {
    admanagerApi.mockResolvedValueOnce(answer(200, { STATUS_MESSAGE: 'Account already exists' }));
    const handlers = register();
    const result = await handlers.get('admanager_create_user_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      ouPath: 'OU=Users,DC=corp,DC=example',
      firstName: 'Jane',
      lastName: 'Doe',
      sAMAccountName: 'jdoe',
      userPrincipalName: 'jdoe@corp.example',
      password: 'Sup3r!Secret9000',
      templateName: 'AD Create Template',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Account already exists/);
  });

  it('disables the account after creation when enabled: false', async () => {
    admanagerApi
      .mockResolvedValueOnce(answer(200, [{ status: 'SUCCESS', 'SAM Account Name': 'jdoe' }]))
      .mockResolvedValueOnce(answer(200, [{ status: '1', statusMessage: 'Disabled.' }]));
    const handlers = register();
    await handlers.get('admanager_create_user_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      ouPath: 'OU=Users,DC=corp,DC=example',
      firstName: 'Jane',
      lastName: 'Doe',
      sAMAccountName: 'jdoe',
      userPrincipalName: 'jdoe@corp.example',
      password: 'Sup3r!Secret9000',
      templateName: 'AD Create Template',
      enabled: false,
    });
    expect(admanagerApi).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        method: 'POST',
        path: '/RestAPI/DisableUser',
        query: { domainName: 'corp.example', inputFormat: JSON.stringify([{ sAMAccountName: 'jdoe' }]) },
      })
    );
  });
});

describe('update user: a logical PATCH failure is reported, not swallowed', () => {
  it('preview never requests TELEPHONE_NUMBER or DESCRIPTION for the old-value lookup', async () => {
    admanagerApi.mockResolvedValueOnce(usersResponse([{ DISPLAY_NAME: 'Jane Doe' }]));
    const handlers = register();
    await handlers.get('admanager_update_user_preview')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      telephoneNumber: '555-1234',
      description: 'Updated bio',
      templateName: 'AD Update Template',
    });
    const fields = String(
      (admanagerApi.mock.calls[0]?.[1] as { query?: { fields?: string } } | undefined)?.query?.fields
    );
    expect(fields).not.toMatch(/TELEPHONE_NUMBER|DESCRIPTION/);
  });

  it('reports success with the per-item status message', async () => {
    admanagerApi.mockResolvedValueOnce(
      answer(200, { data: [{ status: { status_code: 1, status_message: 'Successfully modified.' } }] })
    );
    const handlers = register();
    const result = await handlers.get('admanager_update_user_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      department: 'Finance',
      templateName: 'AD Update Template',
    });
    expect(textOf(result)).toMatch(/Updated jdoe in corp.example/);
    expect(textOf(result)).toContain('Successfully modified.');
    expect(admanagerApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: {
          template: { template_name: 'AD Update Template' },
          data: { attributes: { department: 'Finance' } },
        },
      })
    );
  });

  it('reports a per-item failure as an error rather than "Updated"', async () => {
    admanagerApi.mockResolvedValueOnce(
      answer(200, { data: [{ status: { status_code: 0, status_message: 'Attribute rejected' } }] })
    );
    const handlers = register();
    const result = await handlers.get('admanager_update_user_confirm')!({
      instanceId: INSTANCE_ID,
      domainName: 'corp.example',
      samAccountName: 'jdoe',
      department: 'Finance',
      templateName: 'AD Update Template',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Attribute rejected/);
  });
});

describe('unknown instance is not an existence oracle', () => {
  it('answers the same refusal for a missing instance as for one not connected', async () => {
    const handlers = register();
    const result = await handlers.get('admanager_get_user')!({
      instanceId: 'not-a-real-instance',
      domainName: 'corp.example',
      samAccountName: 'jdoe',
    });
    expect(textOf(result)).toBe(NO_SUCH_INSTANCE);
  });
});
