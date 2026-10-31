/**
 * The names behind the ids a Jira Service Management act's preview card
 * carries (see ../lookup.ts): the service desk, the alert, the on-call
 * schedule and rotation, the integrations a maintenance window silences,
 * the people an accountId stands for. Each lookup only reads; a failure
 * just leaves the name out and the card says "the alert" rather than an id.
 */

import type { MCPToolContext } from '../common';
import { registerPreviewLookups } from '../lookup';
import { nameKey, record, records, strings, text, type Args, type Names } from '../previews/card';
import { serviceDeskScopes, type JsmAuth } from './jsm-auth';
import { opsScopes, type JsmOpsAuth } from './ops-auth';

export function registerJsmPreviewLookups(
  context: MCPToolContext,
  jsm: JsmAuth,
  ops: JsmOpsAuth
): void {
  const readJsm = async (path: string): Promise<unknown> => {
    try {
      const response = await jsm.fetch(serviceDeskScopes('jsm_lookup', true), path);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  const readOps = async (tool: string, path: string): Promise<Args | null> => {
    try {
      const response = await ops.fetch(opsScopes(tool, true), path);
      return response.ok ? record(await response.json()) : null;
    } catch {
      return null;
    }
  };
  const id = (value: unknown) => encodeURIComponent(text(value));

  /** A person by Atlassian accountId; an email or a name is already readable and left alone. */
  const user = async (accountId: unknown): Promise<Names> => {
    const value = text(accountId);
    if (!value || value.includes('@')) return {};
    const found = record(await readJsm(`/rest/api/3/user?accountId=${id(value)}`));
    return text(found.displayName) ? { [nameKey('user', value)]: text(found.displayName) } : {};
  };

  const users = async (values: unknown[]): Promise<Names> =>
    Object.assign({}, ...(await Promise.all(values.map(user))));

  const merge = async (...parts: Promise<Names>[]): Promise<Names> =>
    Object.assign({}, ...(await Promise.all(parts)));

  const desk = async (serviceDeskId: unknown): Promise<Names> => {
    if (!text(serviceDeskId)) return {};
    const found = record(await readJsm(`/rest/servicedeskapi/servicedesk/${id(serviceDeskId)}`));
    return text(found.projectName)
      ? { [nameKey('desk', text(serviceDeskId))]: text(found.projectName) }
      : {};
  };

  const alert = async (args: Args): Promise<Names> => {
    const found = await readOps('jsm_ops_get_alert', `/alerts/${id(args.alertId)}`);
    return text(found?.message)
      ? { [nameKey('alert', text(args.alertId))]: text(found?.message) }
      : {};
  };

  const schedule = async (scheduleId: unknown): Promise<Names> => {
    if (!text(scheduleId)) return {};
    const found = await readOps('jsm_ops_list_schedules', `/schedules/${id(scheduleId)}`);
    return text(found?.name) ? { [nameKey('schedule', text(scheduleId))]: text(found?.name) } : {};
  };

  const rotation = async (scheduleId: unknown, rotationId: unknown): Promise<Names> => {
    if (!text(scheduleId) || !text(rotationId)) return {};
    const found = await readOps(
      'jsm_ops_get_rotation',
      `/schedules/${id(scheduleId)}/rotations/${id(rotationId)}`
    );
    return text(found?.name) ? { [nameKey('rotation', text(rotationId))]: text(found?.name) } : {};
  };

  const participant = async (args: Args): Promise<Names> => {
    // A removal can read the name off the request's own participant list.
    const list = record(
      await readJsm(`/rest/servicedeskapi/request/${id(args.issueKey)}/participant`)
    );
    const match = records(list.values).find((p) => text(p.accountId) === text(args.accountId));
    return text(match?.displayName)
      ? { [nameKey('user', text(args.accountId))]: text(match?.displayName) }
      : user(args.accountId);
  };

  const maintenance = async (args: Args): Promise<Names> => {
    const teamId = text(args.teamId);
    const path = teamId
      ? `/teams/${id(teamId)}/maintenances/${id(args.maintenanceId)}`
      : `/maintenances/${id(args.maintenanceId)}`;
    const found = await readOps('jsm_ops_get_maintenance', path);
    return text(found?.description)
      ? { [nameKey('maintenance', text(args.maintenanceId))]: text(found?.description) }
      : {};
  };

  const integrations = async (ids: string[]): Promise<Names> => {
    const found = await Promise.all(
      ids.map(async (integrationId) => {
        const body = await readOps(
          'jsm_ops_list_integrations',
          `/integrations/${id(integrationId)}`
        );
        return text(body?.name)
          ? { [nameKey('integration', integrationId)]: text(body?.name) }
          : {};
      })
    );
    return Object.assign({}, ...found);
  };

  registerPreviewLookups(context, {
    jsm_add_request_participant: (args) => user(args.accountId),
    jsm_remove_request_participant: participant,

    jsm_add_customer_to_servicedesk: (args) => merge(desk(args.serviceDeskId), user(args.user)),
    jsm_remove_customer_from_servicedesk: (args) =>
      merge(desk(args.serviceDeskId), user(args.user)),
    jsm_invite_customers_to_servicedesk: (args) => desk(args.serviceDeskId),

    jsm_ops_acknowledge_alert: alert,
    jsm_ops_close_alert: alert,

    jsm_ops_create_override: async (args) =>
      merge(
        schedule(args.scheduleId),
        user(args.responderAccountId),
        ...strings(args.rotationIds).map((rotationId) => rotation(args.scheduleId, rotationId))
      ),

    jsm_ops_delete_override: async (args) => {
      const found = await readOps(
        'jsm_ops_list_overrides',
        `/schedules/${id(args.scheduleId)}/overrides/${id(args.alias)}`
      );
      const responder = text(record(found?.responder).id);
      const who = responder ? await user(responder) : {};
      const name = who[nameKey('user', responder)];
      return merge(
        schedule(args.scheduleId),
        Promise.resolve(
          name
            ? {
                [nameKey('override', text(args.alias))]:
                  `${name} covering ${text(found?.startDate)} → ${text(found?.endDate)}`,
              }
            : {}
        )
      );
    },

    jsm_ops_update_rotation: async (args) =>
      merge(
        schedule(args.scheduleId),
        rotation(args.scheduleId, args.rotationId),
        users(strings(args.participantAccountIds))
      ),

    jsm_ops_create_maintenance: (args) => integrations(strings(args.integrationIds)),
    jsm_ops_cancel_maintenance: maintenance,
  });
}
