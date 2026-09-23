/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Names ↔ ids: the resolution rules (exact id, exact name, folded name,
 * re-read on a miss, UUID pass-through, ambiguity refusals), the argument
 * sweep by name, instance references by name or environment, the legend,
 * the cached directory, and the server wrapper end to end.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { ConnectedInstance } from '@renkei/connector-mirth';
import {
  createDirectory,
  legendFor,
  resetDirectoryCache,
  resolveArgs,
  resolveInstanceRef,
  resolveRef,
  withReferenceResolution,
  type Directory,
  type RefEntry,
  type RefKind,
} from './resolve';

const CH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CH_NEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AL_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function stubDirectory(
  table: Partial<Record<RefKind, RefEntry[]>>,
  onFresh?: () => void
): Directory {
  return {
    async entries(_instanceId, kind, _scope, fresh) {
      if (fresh) onFresh?.();
      return table[kind] ?? [];
    },
  };
}

const directory = stubDirectory({
  channel: [
    { id: CH_A, name: 'ADT In' },
    { id: CH_B, name: 'Lab Out' },
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Dup' },
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'dup' },
  ],
  alert: [{ id: AL_1, name: 'Queue alert' }],
  user: [
    { id: '1', name: 'admin' },
    { id: '7', name: 'alice' },
  ],
  connector: [
    { id: '0', name: 'sourceConnector' },
    { id: '1', name: 'Lab Results' },
  ],
});

describe('resolveRef', () => {
  it('passes an id through, and finds a name exactly, then case-folded', async () => {
    expect(await resolveRef(directory, 'i', 'channel', CH_A)).toEqual({
      ok: true,
      id: CH_A,
      name: 'ADT In',
    });
    expect(await resolveRef(directory, 'i', 'channel', 'Lab Out')).toEqual({
      ok: true,
      id: CH_B,
      name: 'Lab Out',
    });
    expect(await resolveRef(directory, 'i', 'channel', 'lab out')).toEqual({
      ok: true,
      id: CH_B,
      name: 'Lab Out',
    });
  });

  it('prefers an exact-case match over a folded one, and refuses a truly ambiguous name', async () => {
    const exact = await resolveRef(directory, 'i', 'channel', 'Dup');
    expect(exact).toMatchObject({ ok: true, name: 'Dup' });
    const folded = await resolveRef(directory, 'i', 'channel', 'DUP');
    expect(folded.ok).toBe(false);
    if (!folded.ok) expect(folded.message).toContain('names 2 channels');
  });

  it('re-reads once on a miss, then passes an unknown UUID through and refuses an unknown name', async () => {
    let fresh = 0;
    const counting = stubDirectory({ channel: [{ id: CH_A, name: 'ADT In' }] }, () => fresh++);
    expect(await resolveRef(counting, 'i', 'channel', CH_NEW)).toEqual({
      ok: true,
      id: CH_NEW,
      name: null,
    });
    expect(fresh).toBe(1);
    const missing = await resolveRef(counting, 'i', 'channel', 'Radiology');
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.message).toBe(
        'No channel named "Radiology" on this instance. Known: "ADT In".'
      );
  });

  it('treats numbers and digit strings as ids for integer kinds, and resolves names to numbers', async () => {
    expect(await resolveRef(directory, 'i', 'user', 7)).toEqual({ ok: true, id: 7, name: null });
    expect(await resolveRef(directory, 'i', 'user', '7')).toEqual({ ok: true, id: 7, name: null });
    expect(await resolveRef(directory, 'i', 'user', 'alice')).toEqual({
      ok: true,
      id: 7,
      name: 'alice',
    });
    expect(
      await resolveRef(directory, 'i', 'connector', 'Lab Results', { channelId: CH_A })
    ).toEqual({
      ok: true,
      id: 1,
      name: 'Lab Results',
    });
  });

  it('surfaces a directory refusal', async () => {
    const closed: Directory = {
      entries: async () => 'Could not reach the Mirth service to list the channels.',
    };
    expect(await resolveRef(closed, 'i', 'channel', 'ADT In')).toEqual({
      ok: false,
      message: 'Could not reach the Mirth service to list the channels.',
    });
  });
});

describe('resolveArgs', () => {
  it('resolves every reference argument by name, channels first so connectors scope to them', async () => {
    const seen: string[] = [];
    const scoped: Directory = {
      async entries(_instanceId, kind, scope) {
        seen.push(`${kind}:${scope?.channelId ?? ''}`);
        return directory.entries('i', kind, scope);
      },
    };
    const resolved = await resolveArgs(scoped, 'i', {
      instanceId: 'i',
      channelId: 'ADT In',
      channelIds: ['Lab Out', CH_A],
      metaDataId: 'Lab Results',
      destinationMetaDataIds: ['Lab Results', 0],
      includedMetaDataId: ['sourceConnector'],
      alertId: 'queue alert',
      userId: 'alice',
      other: 'left alone',
    });
    expect(resolved).toEqual({
      ok: true,
      args: {
        instanceId: 'i',
        channelId: CH_A,
        channelIds: [CH_B, CH_A],
        metaDataId: 1,
        destinationMetaDataIds: [1, 0],
        includedMetaDataId: [0],
        alertId: AL_1,
        userId: 7,
        other: 'left alone',
      },
    });
    expect(seen[0]).toBe(`channel:`);
    expect(seen).toContain(`connector:${CH_A}`);
  });

  it('stops at the first unresolvable reference', async () => {
    const result = await resolveArgs(directory, 'i', { channelId: 'ADT In', alertId: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('No alert named "nope"');
  });
});

describe('resolveInstanceRef', () => {
  const connected = (name: string, environment: string, id: string): ConnectedInstance => ({
    instance: {
      id,
      name,
      environment,
      baseUrl: 'https://x',
      tlsVerify: true,
      hasCustomCa: false,
      allowInsecureHttp: false,
      enabled: true,
    },
    connection: { username: 'alice', permissions: ['channels.read'] },
  });
  const instances = [
    connected('Mirth prod', 'prod', 'p'),
    connected('Mirth dev', 'dev', 'd'),
    connected('Site B', 'dev', 'b'),
  ];

  it('accepts the id, the name (any case) and a unique environment label', () => {
    expect(resolveInstanceRef(instances, 'p')).toEqual({ ok: true, id: 'p' });
    expect(resolveInstanceRef(instances, 'mirth DEV')).toEqual({ ok: true, id: 'd' });
    expect(resolveInstanceRef(instances, 'prod')).toEqual({ ok: true, id: 'p' });
  });

  it('refuses a shared label and an unknown name, naming what is connected', () => {
    const shared = resolveInstanceRef(instances, 'dev');
    expect(shared.ok).toBe(false);
    if (!shared.ok) expect(shared.message).toContain('matches 2 connected instances');
    const unknown = resolveInstanceRef(instances, 'qa');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(unknown.message).toContain(
        'Connected: Mirth prod [prod], Mirth dev [dev], Site B [dev].'
      );
  });
});

describe('legendFor', () => {
  it('names the ids the text mentions whose names are absent, and nothing else', async () => {
    const text = `statuses: ${CH_A} STARTED; ${CH_B} STOPPED (Lab Out); ${CH_NEW} UNKNOWN; alert ${AL_1}`;
    expect(await legendFor(directory, 'i', text)).toBe(
      `\n\nIds in this answer:\n${CH_A} — channel "ADT In"\n${AL_1} — alert "Queue alert"`
    );
    expect(await legendFor(directory, 'i', 'nothing here')).toBe('');
  });
});

describe('createDirectory', () => {
  beforeEach(() => resetDirectoryCache());

  it('caches a listing per instance and kind, honours fresh, and parses each kind', async () => {
    const calls: string[] = [];
    let now = 1_000;
    const call = async (_instanceId: string, _what: string, request: { path: string }) => {
      calls.push(request.path);
      const bodies: Record<string, unknown> = {
        '/channels/idsAndNames': { map: { entry: [{ string: [CH_A, 'ADT In'] }] } },
        '/users': { list: { user: [{ id: 7, username: 'alice' }] } },
        [`/channels/${CH_A}/connectorNames`]: {
          map: { entry: [{ int: 0, string: 'sourceConnector' }] },
        },
        '/codeTemplateLibraries': {
          list: {
            codeTemplateLibrary: {
              id: 'L',
              name: 'Lib',
              codeTemplates: { codeTemplate: [{ id: 'T', name: 'Tpl' }] },
            },
          },
        },
      };
      return {
        ok: true as const,
        response: {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(bodies[request.path] ?? { list: '' }),
        },
      };
    };
    const dir = createDirectory(call, 't|alice', () => now);
    expect(await dir.entries('i', 'channel')).toEqual([{ id: CH_A, name: 'ADT In' }]);
    expect(await dir.entries('i', 'channel')).toEqual([{ id: CH_A, name: 'ADT In' }]);
    expect(calls).toEqual(['/channels/idsAndNames']);
    await dir.entries('i', 'channel', {}, true);
    expect(calls).toHaveLength(2);
    now += 61_000;
    await dir.entries('i', 'channel');
    expect(calls).toHaveLength(3);

    expect(await dir.entries('i', 'user')).toEqual([{ id: '7', name: 'alice' }]);
    expect(await dir.entries('i', 'connector', { channelId: CH_A })).toEqual([
      { id: '0', name: 'sourceConnector' },
    ]);
    expect(await dir.entries('i', 'code_template_library')).toEqual([{ id: 'L', name: 'Lib' }]);
    expect(await dir.entries('i', 'code_template')).toEqual([{ id: 'T', name: 'Tpl' }]);
    expect(await dir.entries('i', 'connector')).toBe(
      'A connector name can only be resolved for a given channel.'
    );
  });
});

describe('withReferenceResolution', () => {
  type Handler = (
    args: Record<string, unknown>
  ) => Promise<{ content: { type: 'text'; text: string }[]; isError?: true }>;

  function wrap(listConnected: () => Promise<ConnectedInstance[] | string>) {
    const registered = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        registered.set(name, handler);
      },
    } as unknown as McpServer;
    const wrapped = withReferenceResolution(server, { listConnected, directory });
    return { wrapped, registered };
  }

  const prod: ConnectedInstance = {
    instance: {
      id: 'p',
      name: 'Prod',
      environment: 'prod',
      baseUrl: 'https://x',
      tlsVerify: true,
      hasCustomCa: false,
      allowInsecureHttp: false,
      enabled: true,
    },
    connection: { username: 'alice', permissions: ['channels.read'] },
  };

  it('hands the handler ids for the names given, and appends a legend to its answer', async () => {
    const { wrapped, registered } = wrap(async () => [prod]);
    const received: Record<string, unknown>[] = [];
    wrapped.registerTool(
      'mirth_x',
      { inputSchema: undefined } as never,
      (async (args: Record<string, unknown>) => {
        received.push(args);
        return {
          content: [{ type: 'text' as const, text: `channel ${args.channelId}, alert ${AL_1}` }],
        };
      }) as never
    );
    const result = await registered.get('mirth_x')!({
      instanceId: 'prod',
      channelId: 'ADT In',
      alertId: 'Queue alert',
    });
    expect(received).toEqual([{ instanceId: 'p', channelId: CH_A, alertId: AL_1 }]);
    expect(result.content[0].text).toBe(
      `channel ${CH_A}, alert ${AL_1}\n\nIds in this answer:\n${CH_A} — channel "ADT In"\n${AL_1} — alert "Queue alert"`
    );
  });

  it('refuses before the handler when the instance or a name is unknown, and leaves errors alone', async () => {
    const { wrapped, registered } = wrap(async () => [prod]);
    let ran = 0;
    wrapped.registerTool(
      'mirth_y',
      {} as never,
      (async () => {
        ran += 1;
        return {
          content: [{ type: 'text' as const, text: `bad ${CH_A}` }],
          isError: true as const,
        };
      }) as never
    );
    const tool = registered.get('mirth_y')!;
    expect((await tool({ instanceId: 'qa' })).isError).toBe(true);
    expect((await tool({ instanceId: 'prod', channelId: 'Radiology' })).isError).toBe(true);
    expect(ran).toBe(0);
    const failed = await tool({ instanceId: 'prod' });
    expect(failed.content[0].text).toBe(`bad ${CH_A}`);
    expect(ran).toBe(1);
  });

  it('passes tools without an instanceId straight through', async () => {
    const { wrapped, registered } = wrap(async () => 'nope');
    wrapped.registerTool(
      'mirth_list_instances',
      {} as never,
      (async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })) as never
    );
    expect((await registered.get('mirth_list_instances')!({})).content[0].text).toBe('ok');
  });
});
