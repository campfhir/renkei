/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The Mirth tools' contract at the model boundary. Since the Mirth worker
 * owns the login and every request on the caller's own credentials, what
 * these tools own is what this suite pins: faithful forwarding of the
 * caller's target and the exact REST route, the unwrapping of Mirth's
 * XStream-flavoured JSON into readable lines, the mapping of worker and
 * upstream refusals onto model-readable messages, the per-instance
 * LLM-exposure gates (act and destructive opt-ins), the shaped
 * registration, the destructive classification of generic requests, and
 * the preview/confirm cards.
 */

jest.mock('@/lib/mirth/service-client', () => ({
  mirthApi: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import type { InstanceConnection, MirthInstanceSummary } from '@renkei/connector-mirth';
import { registerMirthTools, type MirthToolExposure } from './index';
import { NO_SUCH_INSTANCE } from './mirth-auth';
import type { MirthAuth } from './mirth-auth';
import type { MCPToolContext } from '../common';

const { mirthApi } = jest.requireMock<{ mirthApi: jest.Mock }>('@/lib/mirth/service-client');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

const INSTANCE_ID = '11111111-2222-3333-4444-555555555555';
const TARGET = { tenantId: 'tenant-1', subject: 'auth0|alice', instanceId: INSTANCE_ID };

function contextOf(): MCPToolContext {
  return { tenantId: 'tenant-1', subject: 'auth0|alice' } as unknown as MCPToolContext;
}

function summary(): MirthInstanceSummary {
  return {
    id: INSTANCE_ID,
    name: 'Prod',
    environment: 'prod',
    baseUrl: 'https://mirth.example:8443',
    tlsVerify: true,
    hasCustomCa: false,
    allowInsecureHttp: false,
    enabled: true,
  };
}

function connectionOf(overrides?: Partial<InstanceConnection>): InstanceConnection {
  return { username: 'alice', toolAccess: 'read_write', allowDestructive: true, ...overrides };
}

function authOf(connection: InstanceConnection): MirthAuth {
  return {
    kind: 'user',
    target() {
      return { tenantId: 'tenant-1', subject: 'auth0|alice' };
    },
    async listConnected() {
      return [{ instance: summary(), connection }];
    },
    async connection(instanceId: string) {
      if (instanceId !== INSTANCE_ID) return NO_SUCH_INSTANCE;
      return connection;
    },
  };
}

function register(
  connection: InstanceConnection = connectionOf(),
  exposure: MirthToolExposure = { write: true, destructive: true }
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerMirthTools(server, contextOf(), authOf(connection), exposure);
  return handlers;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

const answer = (status: number, body: unknown, contentType = 'application/json') => ({
  ok: true as const,
  val: { status, contentType, body: typeof body === 'string' ? body : JSON.stringify(body) },
});

const opError = (type: string, message?: string, status = 400) => ({
  ok: false as const,
  err: { kind: 'op' as const, type, message, status },
});

beforeEach(() => jest.clearAllMocks());

describe('registration shape', () => {
  it('mounts only the read tools without a write exposure, and no destructive tools without that', () => {
    const readOnly = [
      ...register(connectionOf({ toolAccess: 'read' }), {
        write: false,
        destructive: false,
      }).keys(),
    ];
    expect(readOnly).toContain('mirth_list_channels');
    expect(readOnly).not.toContain('mirth_deploy_channels');
    expect(readOnly).not.toContain('mirth_delete_channel_preview');

    const writer = [...register(connectionOf(), { write: true, destructive: false }).keys()];
    expect(writer).toContain('mirth_deploy_channels');
    expect(writer).toContain('mirth_update_alert');
    expect(writer).not.toContain('mirth_delete_channel_preview');
    expect(writer).not.toContain('mirth_delete_alert_preview');

    const all = [...register().keys()];
    expect(all).toContain('mirth_delete_channel_confirm');
    expect(all).toContain('mirth_remove_messages_confirm');
    expect(all).toContain('mirth_delete_alert_confirm');
    expect(all).not.toContain('mirth_api_request');
    expect(all).not.toContain('mirth_api_get');
  });
});

describe('mirth_list_instances', () => {
  it('lists the connected instances with environment, id and exposure', async () => {
    const result = await register().get('mirth_list_instances')!({});
    expect(textOf(result)).toContain('Prod [prod] — id ' + INSTANCE_ID);
    expect(textOf(result)).toContain('connected as alice');
    expect(textOf(result)).toContain('read/write + destructive');
  });
});

describe('mirth_list_channels', () => {
  it('merges idsAndNames with dashboard statuses, marking undeployed channels', async () => {
    mirthApi
      .mockResolvedValueOnce(
        answer(200, {
          map: { entry: [{ string: ['c1', 'ADT In'] }, { string: ['c2', 'Lab Out'] }] },
        })
      )
      .mockResolvedValueOnce(
        answer(200, {
          list: {
            dashboardStatus: {
              channelId: 'c1',
              name: 'ADT In',
              state: 'STARTED',
              deployedRevisionDelta: 2,
              statistics: {
                map: {
                  entry: [
                    { string: 'RECEIVED', long: 10 },
                    { string: 'ERROR', long: 1 },
                  ],
                },
              },
            },
          },
        })
      );
    const result = await register().get('mirth_list_channels')!({ instanceId: INSTANCE_ID });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('2 channel(s)');
    expect(text).toContain(
      'ADT In — id c1 — STARTED — 2 undeployed revision(s) — received 10, error 1'
    );
    expect(text).toContain('Lab Out — id c2 — UNDEPLOYED');

    expect(mirthApi).toHaveBeenNthCalledWith(1, TARGET, {
      method: 'GET',
      path: '/channels/idsAndNames',
      query: undefined,
    });
    expect(mirthApi).toHaveBeenNthCalledWith(2, TARGET, {
      method: 'GET',
      path: '/channels/statuses',
      query: { includeUndeployed: true },
    });
  });

  it('filters by a name fragment', async () => {
    mirthApi
      .mockResolvedValueOnce(
        answer(200, {
          map: { entry: [{ string: ['c1', 'ADT In'] }, { string: ['c2', 'Lab Out'] }] },
        })
      )
      .mockResolvedValueOnce(answer(200, { list: '' }));
    const result = await register().get('mirth_list_channels')!({
      instanceId: INSTANCE_ID,
      nameContains: 'lab',
    });
    expect(textOf(result)).toContain('1 channel(s)');
    expect(textOf(result)).not.toContain('ADT In');
  });
});

describe('mirth_get_channel', () => {
  it('asks for XML verbatim when the caller wants the export form', async () => {
    mirthApi.mockResolvedValueOnce(
      answer(200, '<channel><id>c1</id></channel>', 'application/xml')
    );
    const result = await register().get('mirth_get_channel')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
      format: 'xml',
    });
    expect(textOf(result)).toBe('<channel><id>c1</id></channel>');
    expect(mirthApi).toHaveBeenCalledWith(TARGET, {
      method: 'GET',
      path: '/channels/c1',
      accept: 'application/xml',
    });
  });

  it('summarizes the connectors', async () => {
    mirthApi.mockResolvedValueOnce(
      answer(200, {
        channel: {
          id: 'c1',
          name: 'ADT In',
          revision: 7,
          sourceConnector: {
            name: 'sourceConnector',
            transportName: 'TCP Listener',
            properties: { a: 1 },
          },
          destinationConnectors: {
            connector: [
              { name: 'To Lab', transportName: 'Channel Writer', metaDataId: 1, enabled: true },
              { name: 'Archive', transportName: 'File Writer', metaDataId: 2, enabled: false },
            ],
          },
          preprocessingScript: 'return message;',
        },
      })
    );
    const text = textOf(
      await register().get('mirth_get_channel')!({ instanceId: INSTANCE_ID, channelId: 'c1' })
    );
    expect(text).toContain('ADT In — id c1 — revision 7');
    expect(text).toContain('Source: sourceConnector (TCP Listener)');
    expect(text).toContain('To Lab (Channel Writer) — metaDataId 1 — enabled');
    expect(text).toContain('Archive (File Writer) — metaDataId 2 — disabled');
  });
});

describe('refusals', () => {
  it('phrases worker refusals and upstream verdicts for the model', async () => {
    const tools = register();
    mirthApi.mockResolvedValueOnce(opError('not_connected', undefined, 403));
    expect(textOf(await tools.get('mirth_server_info')!({ instanceId: INSTANCE_ID }))).toBe(
      NO_SUCH_INSTANCE
    );

    mirthApi.mockResolvedValueOnce(opError('login_failed', 'rejected', 403));
    expect(textOf(await tools.get('mirth_server_info')!({ instanceId: INSTANCE_ID }))).toContain(
      'rejected your stored credentials'
    );

    mirthApi.mockResolvedValueOnce({ ok: false, err: { kind: 'unconfigured' } });
    expect(textOf(await tools.get('mirth_server_info')!({ instanceId: INSTANCE_ID }))).toContain(
      'not configured on this deployment'
    );

    mirthApi.mockResolvedValueOnce(answer(403, ''));
    expect(textOf(await tools.get('mirth_server_info')!({ instanceId: INSTANCE_ID }))).toContain(
      'does not have permission'
    );

    mirthApi.mockResolvedValueOnce(answer(500, 'boom'));
    const failed = await tools.get('mirth_server_info')!({ instanceId: INSTANCE_ID });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('Mirth answered 500');
  });
});

describe('exposure gates', () => {
  it('refuses act tools on a read-only connection before any call', async () => {
    const tools = register(connectionOf({ toolAccess: 'read' }));
    const result = await tools.get('mirth_deploy_channels')!({
      instanceId: INSTANCE_ID,
      channelIds: ['c1'],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Act tools are switched off');
    expect(mirthApi).not.toHaveBeenCalled();
  });

  it('refuses destructive tools without the destructive opt-in', async () => {
    const tools = register(connectionOf({ allowDestructive: false }));
    const result = await tools.get('mirth_delete_channel_confirm')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
    });
    expect(textOf(result)).toContain('Destructive operations are switched off');
    expect(mirthApi).not.toHaveBeenCalled();
  });

  it('answers the shared not-connected refusal for an unknown instance', async () => {
    const other = '22222222-2222-3333-4444-555555555555';
    const result = await register().get('mirth_control_channels')!({
      instanceId: other,
      action: 'stop',
      channelIds: ['c1'],
    });
    expect(textOf(result)).toBe(NO_SUCH_INSTANCE);
  });
});

describe('channel control', () => {
  it('deploys per channel with returnErrors and reports per id', async () => {
    mirthApi
      .mockResolvedValueOnce(answer(204, ''))
      .mockResolvedValueOnce(answer(500, 'no such channel'));
    const result = await register().get('mirth_deploy_channels')!({
      instanceId: INSTANCE_ID,
      channelIds: ['c1', 'c9'],
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('1/2 succeeded');
    expect(textOf(result)).toContain('c1: ok');
    expect(textOf(result)).toContain('c9: Mirth answered 500');
    expect(mirthApi).toHaveBeenNthCalledWith(1, TARGET, {
      method: 'POST',
      path: '/channels/c1/_deploy',
      query: { returnErrors: true },
    });
  });

  it('redeploys everything on all: true', async () => {
    mirthApi.mockResolvedValueOnce(answer(204, ''));
    await register().get('mirth_deploy_channels')!({ instanceId: INSTANCE_ID, all: true });
    expect(mirthApi).toHaveBeenCalledWith(TARGET, {
      method: 'POST',
      path: '/channels/_redeployAll',
      query: { returnErrors: true },
    });
  });

  it('maps control actions onto their routes', async () => {
    mirthApi.mockResolvedValue(answer(204, ''));
    await register().get('mirth_control_channels')!({
      instanceId: INSTANCE_ID,
      action: 'halt',
      channelIds: ['c1'],
    });
    expect(mirthApi).toHaveBeenCalledWith(TARGET, {
      method: 'POST',
      path: '/channels/c1/_halt',
      query: { returnErrors: true },
    });
  });
});

describe('mirth_import_channel', () => {
  it('updates an existing id with override and creates a new one', async () => {
    const tools = register();
    mirthApi
      .mockResolvedValueOnce(answer(200, { map: { entry: [{ string: ['c1', 'ADT In'] }] } }))
      .mockResolvedValueOnce(answer(200, 'true', 'text/plain'));
    const xml = '<channel version="4.5.2"><id>c1</id><name>ADT In</name></channel>';
    const updated = await tools.get('mirth_import_channel')!({
      instanceId: INSTANCE_ID,
      channelXml: xml,
    });
    expect(textOf(updated)).toContain('Channel c1 updated');
    expect(mirthApi).toHaveBeenNthCalledWith(2, TARGET, {
      method: 'PUT',
      path: '/channels/c1',
      query: { override: true },
      body: xml,
      contentType: 'application/xml',
      accept: 'text/plain',
    });

    mirthApi
      .mockResolvedValueOnce(answer(200, { map: '' }))
      .mockResolvedValueOnce(answer(200, 'true', 'text/plain'));
    const created = await tools.get('mirth_import_channel')!({
      instanceId: INSTANCE_ID,
      channelXml: xml,
    });
    expect(textOf(created)).toContain('Channel c1 created');
    expect(mirthApi).toHaveBeenNthCalledWith(
      4,
      TARGET,
      expect.objectContaining({ method: 'POST', path: '/channels' })
    );
  });

  it('refuses XML without an id', async () => {
    const result = await register().get('mirth_import_channel')!({
      instanceId: INSTANCE_ID,
      channelXml: '<channel/>',
    });
    expect(result.isError).toBe(true);
    expect(mirthApi).not.toHaveBeenCalled();
  });
});

describe('messages', () => {
  it('forwards search filters as Mirth query parameters', async () => {
    mirthApi.mockResolvedValueOnce(answer(200, { list: '' }));
    await register().get('mirth_search_messages')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
      status: ['ERROR'],
      startDate: '2026-09-01T00:00:00Z',
      textSearch: 'PID',
      limit: 5,
    });
    expect(mirthApi).toHaveBeenCalledWith(TARGET, {
      method: 'GET',
      path: '/channels/c1/messages',
      query: {
        status: ['ERROR'],
        startDate: '2026-09-01T00:00:00Z',
        textSearch: 'PID',
        includeContent: false,
        limit: 5,
      },
    });
  });

  it('sends a message as raw text with destination and sourceMap query params', async () => {
    mirthApi.mockResolvedValueOnce(answer(204, ''));
    await register().get('mirth_send_message')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
      content: 'MSH|^~\\&|',
      destinationMetaDataIds: [1],
      sourceMap: { source: 'renkei' },
    });
    expect(mirthApi).toHaveBeenCalledWith(TARGET, {
      method: 'POST',
      path: '/channels/c1/messages',
      query: { destinationMetaDataId: ['1'], sourceMapEntry: ['source=renkei'] },
      body: 'MSH|^~\\&|',
      contentType: 'text/plain',
      accept: 'text/plain',
    });
  });

  it('refuses a filterless bulk reprocess', async () => {
    const result = await register().get('mirth_reprocess_messages')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
    });
    expect(result.isError).toBe(true);
    expect(mirthApi).not.toHaveBeenCalled();
  });
});

describe('configuration map', () => {
  it('merges changes into the current map and PUTs the XML form', async () => {
    mirthApi
      .mockResolvedValueOnce(
        answer(200, {
          map: {
            entry: [
              {
                string: 'keep',
                'com.mirth.connect.util.ConfigurationProperty': { value: '1', comment: 'kept' },
              },
              { string: 'drop', 'com.mirth.connect.util.ConfigurationProperty': { value: 'x' } },
            ],
          },
        })
      )
      .mockResolvedValueOnce(answer(204, ''));
    const result = await register().get('mirth_set_configuration_map')!({
      instanceId: INSTANCE_ID,
      entries: { drop: null, added: { value: 'a<b', comment: 'new' } },
    });
    expect(textOf(result)).toContain('removed drop');
    expect(textOf(result)).toContain('added = a<b');
    const put = mirthApi.mock.calls[1][1];
    expect(put.method).toBe('PUT');
    expect(put.path).toBe('/server/configurationMap');
    expect(put.contentType).toBe('application/xml');
    expect(put.body).toBe(
      '<map><entry><string>keep</string><com.mirth.connect.util.ConfigurationProperty><value>1</value><comment>kept</comment></com.mirth.connect.util.ConfigurationProperty></entry>' +
        '<entry><string>added</string><com.mirth.connect.util.ConfigurationProperty><value>a&lt;b</value><comment>new</comment></com.mirth.connect.util.ConfigurationProperty></entry></map>'
    );
  });
});

describe('destructive cards', () => {
  it('previews a channel deletion with its name and confirms through DELETE', async () => {
    const tools = register();
    mirthApi.mockResolvedValueOnce(answer(200, { map: { entry: [{ string: ['c1', 'ADT In'] }] } }));
    const preview = await tools.get('mirth_delete_channel_preview')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
    });
    expect(preview.structuredContent).toMatchObject({
      kind: 'issue',
      title: 'Delete channel ADT In permanently',
      confirmTool: 'mirth_delete_channel_confirm',
      confirmArgs: { instanceId: INSTANCE_ID, channelId: 'c1' },
    });

    mirthApi.mockResolvedValueOnce(answer(204, ''));
    const confirmed = await tools.get('mirth_delete_channel_confirm')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
    });
    expect(textOf(confirmed)).toBe('Channel c1 deleted.');
    expect(mirthApi).toHaveBeenLastCalledWith(TARGET, { method: 'DELETE', path: '/channels/c1' });
  });

  it('previews a message purge with the count, and confirms with the right route', async () => {
    const tools = register();
    mirthApi.mockResolvedValueOnce(answer(200, '42', 'text/plain'));
    const preview = await tools.get('mirth_remove_messages_preview')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
      all: true,
      clearStatistics: true,
    });
    expect(preview.structuredContent).toMatchObject({ title: 'Remove every message permanently' });

    mirthApi.mockResolvedValueOnce(answer(204, ''));
    await tools.get('mirth_remove_messages_confirm')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
      all: true,
      clearStatistics: true,
    });
    expect(mirthApi).toHaveBeenLastCalledWith(TARGET, {
      method: 'DELETE',
      path: '/channels/c1/messages/_removeAll',
      query: { restartRunningChannels: true, clearStatistics: true },
    });

    mirthApi.mockResolvedValueOnce(answer(204, ''));
    await tools.get('mirth_remove_messages_confirm')!({
      instanceId: INSTANCE_ID,
      channelId: 'c1',
      status: ['ERROR'],
    });
    expect(mirthApi).toHaveBeenLastCalledWith(TARGET, {
      method: 'DELETE',
      path: '/channels/c1/messages',
      query: { status: ['ERROR'] },
    });
  });
});
