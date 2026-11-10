/* eslint-disable @typescript-eslint/consistent-type-assertions */
import type { MCPToolContext } from '../common';
import { lookupNames } from '../lookup';
import { nameKey } from '../previews/card';
import type { JsmAuth } from './jsm-auth';
import type { JsmOpsAuth } from './ops-auth';
import { registerJsmPreviewLookups } from './preview-lookups';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(answers: Record<string, unknown>) {
  const paths: string[] = [];
  const answer = async (_scopes: readonly string[], path: string) => {
    paths.push(path);
    const hit = Object.entries(answers).find(([prefix]) => path.startsWith(prefix));
    return hit ? json(hit[1]) : json({}, 404);
  };
  const jsm: JsmAuth = { kind: 'pat', fetch: answer };
  const ops: JsmOpsAuth = { kind: 'pat', fetch: answer };
  const context = {} as MCPToolContext;
  registerJsmPreviewLookups(context, jsm, ops);
  return { context, paths };
}

describe('jsm preview lookups', () => {
  it('reads the alert message', async () => {
    const { context } = setup({ '/alerts/a1': { message: 'CPU high' } });
    await expect(lookupNames(context, 'jsm_ops_close_alert', { alertId: 'a1' })).resolves.toEqual({
      [nameKey('alert', 'a1')]: 'CPU high',
    });
  });

  it('names the service desk and the customer', async () => {
    const { context } = setup({
      '/rest/servicedeskapi/servicedesk/4': { projectName: 'IT Help' },
      '/rest/api/3/user?accountId=5b10a2844c20165700ede21g': { displayName: 'Ann Lee' },
    });
    await expect(
      lookupNames(context, 'jsm_add_customer_to_servicedesk', {
        serviceDeskId: '4',
        user: '5b10a2844c20165700ede21g',
      })
    ).resolves.toEqual({
      [nameKey('desk', '4')]: 'IT Help',
      [nameKey('user', '5b10a2844c20165700ede21g')]: 'Ann Lee',
    });
  });

  it('does not look an email up', async () => {
    const { context, paths } = setup({});
    await lookupNames(context, 'jsm_remove_customer_from_servicedesk', {
      serviceDeskId: '4',
      user: 'ann@example.com',
    });
    expect(paths.some((p) => p.includes('/user'))).toBe(false);
  });

  it('reads a participant off the request before searching users', async () => {
    const { context } = setup({
      '/rest/servicedeskapi/request/SUP-1/participant': {
        values: [{ accountId: 'acct-1', displayName: 'Ann Lee' }],
      },
    });
    await expect(
      lookupNames(context, 'jsm_remove_request_participant', {
        issueKey: 'SUP-1',
        accountId: 'acct-1',
      })
    ).resolves.toEqual({ [nameKey('user', 'acct-1')]: 'Ann Lee' });
  });

  it('names an override by who it covers, and the schedule and rotation', async () => {
    const { context } = setup({
      '/schedules/s1/overrides/ov1': {
        responder: { id: 'acct-1' },
        startDate: '2026-01-01',
        endDate: '2026-01-02',
      },
      '/schedules/s1/rotations/r1': { name: 'Weekdays' },
      '/schedules/s1': { name: 'Primary' },
      '/rest/api/3/user?accountId=acct-1': { displayName: 'Ann Lee' },
    });
    await expect(
      lookupNames(context, 'jsm_ops_delete_override', { scheduleId: 's1', alias: 'ov1' })
    ).resolves.toEqual({
      [nameKey('schedule', 's1')]: 'Primary',
      [nameKey('override', 'ov1')]: 'Ann Lee covering 2026-01-01 → 2026-01-02',
    });
    const names = await lookupNames(context, 'jsm_ops_update_rotation', {
      scheduleId: 's1',
      rotationId: 'r1',
      participantAccountIds: ['acct-1'],
    });
    expect(names).toMatchObject({
      [nameKey('rotation', 'r1')]: 'Weekdays',
      [nameKey('user', 'acct-1')]: 'Ann Lee',
    });
  });

  it('names integrations and the maintenance window, using the team path when given', async () => {
    const { context, paths } = setup({
      '/integrations/i1': { name: 'Datadog' },
      '/teams/t1/maintenances/m1': { description: 'Deploy window' },
    });
    await expect(
      lookupNames(context, 'jsm_ops_create_maintenance', { integrationIds: ['i1', 'i2'] })
    ).resolves.toEqual({ [nameKey('integration', 'i1')]: 'Datadog' });
    await expect(
      lookupNames(context, 'jsm_ops_cancel_maintenance', { maintenanceId: 'm1', teamId: 't1' })
    ).resolves.toEqual({ [nameKey('maintenance', 'm1')]: 'Deploy window' });
    expect(paths).toContain('/teams/t1/maintenances/m1');
  });

  it('leaves names out when every read fails', async () => {
    const context = {} as MCPToolContext;
    const failing = async () => {
      throw new Error('down');
    };
    registerJsmPreviewLookups(
      context,
      { kind: 'pat', fetch: failing },
      { kind: 'pat', fetch: failing }
    );
    await expect(lookupNames(context, 'jsm_ops_close_alert', { alertId: 'a1' })).resolves.toEqual(
      {}
    );
  });
});
