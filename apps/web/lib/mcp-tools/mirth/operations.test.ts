/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The generated tools' contract: a schema per operation built from its
 * own fields, exact request construction (path substitution, query
 * encoding, XML / text / form / multipart bodies), registration by kind,
 * the exposure gate, and the destructive preview/confirm pair — driven
 * through registerOperationTools with a scripted runtime.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { MIRTH_OPERATIONS } from '@renkei/connector-mirth';
import type { OperationSpec } from '@renkei/connector-mirth';
import type { MirthApiRequest } from '@/lib/mirth/service-client';
import {
  inputSchemaFor,
  multipartBody,
  registerOperationTools,
  requestFor,
  sampleArgsFor,
  type OperationRuntime,
} from './operations';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

const INSTANCE_ID = '11111111-2222-4333-8444-555555555555';

const byTool = (tool: string): OperationSpec => {
  const found = MIRTH_OPERATIONS.find((operation) => operation.tool === tool);
  if (!found) throw new Error(`no operation ${tool}`);
  return found;
};

describe('inputSchemaFor', () => {
  it('requires instanceId and path params, makes query params optional, and types them', () => {
    const schema = inputSchemaFor(byTool('delete_message'));
    expect(
      schema.safeParse({ instanceId: INSTANCE_ID, channelId: 'c1', messageId: 5 }).success
    ).toBe(true);
    expect(
      schema.safeParse({ instanceId: INSTANCE_ID, channelId: 'c1', messageId: '5' }).success
    ).toBe(false);
    expect(schema.safeParse({ instanceId: INSTANCE_ID, channelId: 'c1' }).success).toBe(false);
    expect(
      schema.safeParse({ instanceId: INSTANCE_ID, channelId: 'c1', messageId: 5, metaDataId: 'x' })
        .success
    ).toBe(false);
    expect(
      schema.safeParse({ instanceId: INSTANCE_ID, channelId: 'c1', messageId: 5, metaDataId: 1 })
        .success
    ).toBe(true);
  });

  it('validates enums, repeatable enums and required query params', () => {
    const events = inputSchemaFor(byTool('count_events'));
    expect(events.safeParse({ instanceId: INSTANCE_ID, levels: ['ERROR'] }).success).toBe(true);
    expect(events.safeParse({ instanceId: INSTANCE_ID, levels: 'ERROR' }).success).toBe(false);
    expect(events.safeParse({ instanceId: INSTANCE_ID, outcome: 'MAYBE' }).success).toBe(false);

    const property = inputSchemaFor(byTool('get_server_property'));
    expect(property.safeParse({ instanceId: INSTANCE_ID, group: 'core', name: 'x' }).success).toBe(
      true
    );
    expect(property.safeParse({ instanceId: INSTANCE_ID, group: 'core' }).success).toBe(false);
  });

  it('requires a body document where the operation needs one, and form fields where it takes a form', () => {
    const alert = inputSchemaFor(byTool('create_alert'));
    expect(alert.safeParse({ instanceId: INSTANCE_ID }).success).toBe(false);
    expect(alert.safeParse({ instanceId: INSTANCE_ID, alertModel: '<alertModel/>' }).success).toBe(
      true
    );

    const enabled = inputSchemaFor(byTool('set_channels_enabled'));
    expect(
      enabled.safeParse({ instanceId: INSTANCE_ID, channelId: ['a'], enabled: true }).success
    ).toBe(true);
    expect(enabled.safeParse({ instanceId: INSTANCE_ID, channelId: ['a'] }).success).toBe(false);
  });

  it('accepts the sample arguments of every operation', () => {
    for (const operation of MIRTH_OPERATIONS) {
      const parsed = inputSchemaFor(operation).safeParse(sampleArgsFor(operation));
      expect({ tool: operation.tool, ok: parsed.success }).toEqual({
        tool: operation.tool,
        ok: true,
      });
    }
  });
});

describe('requestFor', () => {
  it('fills the path, encodes once, and forwards only the query params given', () => {
    const built = requestFor(byTool('delete_message'), {
      instanceId: INSTANCE_ID,
      channelId: 'a b',
      messageId: 5,
      metaDataId: 0,
    });
    expect(built).toEqual({
      ok: true,
      request: { method: 'DELETE', path: '/channels/a%20b/messages/5', query: { metaDataId: 0 } },
    });
  });

  it("sends an XML document with the XML content type and the operation's accept", () => {
    const built = requestFor(byTool('update_code_template'), {
      instanceId: INSTANCE_ID,
      codeTemplateId: 't1',
      override: true,
      codeTemplate: '<codeTemplate/>',
    });
    expect(built).toEqual({
      ok: true,
      request: {
        method: 'PUT',
        path: '/codeTemplates/t1',
        query: { override: true },
        accept: 'text/plain',
        body: '<codeTemplate/>',
        contentType: 'application/xml',
      },
    });
  });

  it('sends plain-text bodies as text/plain and refuses a missing required body', () => {
    const built = requestFor(byTool('set_user_password'), {
      instanceId: INSTANCE_ID,
      userId: 3,
      password: 'pw',
    });
    expect(built.ok && built.request).toEqual({
      method: 'PUT',
      path: '/users/3/password',
      body: 'pw',
      contentType: 'text/plain',
    });
    const missing = requestFor(byTool('set_user_password'), { instanceId: INSTANCE_ID, userId: 3 });
    expect(missing).toEqual({ ok: false, error: 'password is required.' });
  });

  it('encodes form bodies with repeated keys', () => {
    const built = requestFor(byTool('set_channels_initial_state'), {
      instanceId: INSTANCE_ID,
      channelId: ['a', 'b'],
      initialState: 'STOPPED',
    });
    expect(built.ok && built.request).toEqual({
      method: 'POST',
      path: '/channels/_setInitialState',
      body: 'channelId=a&channelId=b&initialState=STOPPED',
      contentType: 'application/x-www-form-urlencoded',
    });
  });

  it('builds multipart bodies from the parts given', () => {
    const built = requestFor(byTool('bulk_update_channel_groups'), {
      instanceId: INSTANCE_ID,
      override: true,
      channelGroups: '<set/>',
    });
    expect(built.ok).toBe(true);
    const request = (built as { request: MirthApiRequest }).request;
    expect(request.contentType).toMatch(/^multipart\/form-data; boundary=renkei-/);
    expect(request.body).toContain('Content-Disposition: form-data; name="channelGroups"');
    expect(request.body).toContain('<set/>');
    expect(request.body).not.toContain('removedChannelGroupIds');
    expect(request.query).toEqual({ override: true });
  });

  it('lays a multipart body out per RFC 7578', () => {
    const { body, contentType } = multipartBody([{ name: 'a', value: '<x/>' }], 'B');
    expect(contentType).toBe('multipart/form-data; boundary=B');
    expect(body).toBe(
      '--B\r\nContent-Disposition: form-data; name="a"\r\nContent-Type: application/xml\r\n\r\n<x/>\r\n--B--\r\n'
    );
  });
});

describe('registerOperationTools', () => {
  let calls: { instanceId: string; request: MirthApiRequest }[];
  let answer: { status: number; contentType: string | null; body: string };
  let refusal: string | null;

  const runtime = (): OperationRuntime => ({
    async call(instanceId, _what, request) {
      calls.push({ instanceId, request });
      if (answer.status >= 400) return { ok: false, message: `Mirth answered ${answer.status}` };
      return { ok: true, response: answer };
    },
    async exposureRefusal() {
      return refusal;
    },
    async instanceName() {
      return 'Prod';
    },
    maxChars: 1_000,
  });

  function register(kind: 'read' | 'act' | 'destructive'): Map<string, Handler> {
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerOperationTools(server, runtime(), kind);
    return handlers;
  }

  beforeEach(() => {
    calls = [];
    answer = { status: 200, contentType: 'application/json', body: '{"list":""}' };
    refusal = null;
  });

  it('registers one tool per read and act operation, and a pair per destructive one', () => {
    const read = [...register('read').keys()];
    expect(read).toContain('mirth_get_server_version');
    expect(read).not.toContain('mirth_update_alert');
    expect(read).toHaveLength(MIRTH_OPERATIONS.filter((o) => o.kind === 'read').length);

    const destructive = [...register('destructive').keys()];
    expect(destructive).toContain('mirth_delete_alert_preview');
    expect(destructive).toContain('mirth_delete_alert_confirm');
    expect(destructive).not.toContain('mirth_delete_alert');
    expect(destructive).toHaveLength(
      2 * MIRTH_OPERATIONS.filter((o) => o.kind === 'destructive').length
    );
  });

  it('runs a read operation and pretty-prints a JSON answer', async () => {
    answer = { status: 200, contentType: 'application/json', body: '{"map":{"entry":[]}}' };
    const result = await register('read').get('mirth_get_user_preferences')!({
      instanceId: INSTANCE_ID,
      userId: 7,
      name: ['a', 'b'],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('{\n  "map": {\n    "entry": []\n  }\n}');
    expect(calls).toEqual([
      {
        instanceId: INSTANCE_ID,
        request: { method: 'GET', path: '/users/7/preferences', query: { name: ['a', 'b'] } },
      },
    ]);
  });

  it('gates act operations on the write exposure before building anything', async () => {
    refusal = 'Act tools are switched off';
    const result = await register('act').get('mirth_update_alert')!({
      instanceId: INSTANCE_ID,
      alertId: 'a1',
      alertModel: '<alertModel/>',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Act tools are switched off');
    expect(calls).toEqual([]);
  });

  it('previews a destructive operation on a card and runs it on confirm', async () => {
    const tools = register('destructive');
    const preview = await tools.get('mirth_delete_alert_preview')!({
      instanceId: INSTANCE_ID,
      alertId: 'a1',
    });
    expect(preview.structuredContent).toMatchObject({
      kind: 'issue',
      title: 'Delete an alert',
      subtitle: 'Prod · DELETE /api/alerts/a1',
      confirmTool: 'mirth_delete_alert_confirm',
      confirmArgs: { instanceId: INSTANCE_ID, alertId: 'a1' },
    });
    expect(calls).toEqual([]);

    answer = { status: 204, contentType: null, body: '' };
    const confirmed = await tools.get('mirth_delete_alert_confirm')!({
      instanceId: INSTANCE_ID,
      alertId: 'a1',
    });
    expect(confirmed.content[0].text).toBe('Done (Mirth answered 204).');
    expect(calls).toEqual([
      { instanceId: INSTANCE_ID, request: { method: 'DELETE', path: '/alerts/a1' } },
    ]);
  });

  it('phrases an upstream failure as an error', async () => {
    answer = { status: 403, contentType: null, body: '' };
    const result = await register('read').get('mirth_get_system_info')!({
      instanceId: INSTANCE_ID,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Mirth answered 403');
  });
});
