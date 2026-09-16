/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Mirth, with no live store behind the tools. Mirrors
 * fileshares.no-sandbox.test.ts: every registered tool, driven for real
 * through registerMirthTools, turns a denied auth into a clean errText()
 * rather than crashing — the guarantee that matters when the registry
 * mounts these tools for a caller whose access evaporated between
 * registration and call.
 */

jest.mock('@renkei/db', () => ({
  getDatabase: () => ({ ok: false, error: 'no db in this suite' }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerMirthTools } from './index';
import { deniedMirthAuth } from './mirth-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const context = (): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    subject: 'subject-1',
  }) as unknown as MCPToolContext;

function tools(): Map<string, Handler> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  registerMirthTools(server, context(), deniedMirthAuth(), { write: true, destructive: true });
  return registered;
}

const INSTANCE = '11111111-2222-3333-4444-555555555555';

const ARGS: Record<string, Record<string, unknown>> = {
  mirth_list_instances: {},
  mirth_server_info: { instanceId: INSTANCE },
  mirth_list_channels: { instanceId: INSTANCE },
  mirth_get_channel: { instanceId: INSTANCE, channelId: 'c1' },
  mirth_channel_status: { instanceId: INSTANCE, channelId: 'c1' },
  mirth_channel_statistics: { instanceId: INSTANCE },
  mirth_list_channel_groups: { instanceId: INSTANCE },
  mirth_search_messages: { instanceId: INSTANCE, channelId: 'c1' },
  mirth_count_messages: { instanceId: INSTANCE, channelId: 'c1' },
  mirth_get_message: { instanceId: INSTANCE, channelId: 'c1', messageId: 1 },
  mirth_list_events: { instanceId: INSTANCE },
  mirth_list_alerts: { instanceId: INSTANCE },
  mirth_get_alert: { instanceId: INSTANCE, alertId: 'a1' },
  mirth_list_code_templates: { instanceId: INSTANCE },
  mirth_get_code_template: { instanceId: INSTANCE, codeTemplateId: 't1' },
  mirth_list_users: { instanceId: INSTANCE },
  mirth_list_extensions: { instanceId: INSTANCE },
  mirth_get_configuration_map: { instanceId: INSTANCE },
  mirth_get_global_scripts: { instanceId: INSTANCE },
  mirth_get_server_settings: { instanceId: INSTANCE },
  mirth_describe_api: { instanceId: INSTANCE },
  mirth_api_get: { instanceId: INSTANCE, path: '/server/id' },
  mirth_deploy_channels: { instanceId: INSTANCE, channelIds: ['c1'] },
  mirth_undeploy_channels: { instanceId: INSTANCE, channelIds: ['c1'] },
  mirth_control_channels: { instanceId: INSTANCE, action: 'start', channelIds: ['c1'] },
  mirth_control_connector: { instanceId: INSTANCE, channelId: 'c1', metaDataId: 1, action: 'stop' },
  mirth_set_channel_enabled: { instanceId: INSTANCE, channelId: 'c1', enabled: true },
  mirth_set_channel_initial_state: {
    instanceId: INSTANCE,
    channelId: 'c1',
    initialState: 'STARTED',
  },
  mirth_import_channel: { instanceId: INSTANCE, channelXml: '<channel><id>c1</id></channel>' },
  mirth_send_message: { instanceId: INSTANCE, channelId: 'c1', content: 'MSH|' },
  mirth_reprocess_messages: { instanceId: INSTANCE, channelId: 'c1', messageId: 1 },
  mirth_set_configuration_map: { instanceId: INSTANCE, entries: { k: 'v' } },
  mirth_set_global_scripts: { instanceId: INSTANCE, scripts: { Deploy: '// x' } },
  mirth_set_alert_enabled: { instanceId: INSTANCE, alertId: 'a1', enabled: false },
  mirth_api_request: { instanceId: INSTANCE, method: 'POST', path: '/server/_generateGUID' },
  mirth_delete_channel_preview: { instanceId: INSTANCE, channelId: 'c1' },
  mirth_delete_channel_confirm: { instanceId: INSTANCE, channelId: 'c1' },
  mirth_remove_messages_preview: { instanceId: INSTANCE, channelId: 'c1', all: true },
  mirth_remove_messages_confirm: { instanceId: INSTANCE, channelId: 'c1', all: true },
  mirth_destructive_request_preview: {
    instanceId: INSTANCE,
    method: 'DELETE',
    path: '/alerts/a1',
    reason: 'test',
  },
  mirth_destructive_request_confirm: {
    instanceId: INSTANCE,
    method: 'DELETE',
    path: '/alerts/a1',
    reason: 'test',
  },
};

describe('mirth tools with a denied auth', () => {
  const registered = tools();

  it('registers every tool this suite drives, and nothing it does not know', () => {
    expect([...registered.keys()].sort()).toEqual(Object.keys(ARGS).sort());
  });

  for (const [name, args] of Object.entries(ARGS)) {
    it(`${name} answers a clean error`, async () => {
      const handler = registered.get(name);
      expect(handler).toBeDefined();
      const result = await handler!(args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('not available for this caller');
    });
  }
});
