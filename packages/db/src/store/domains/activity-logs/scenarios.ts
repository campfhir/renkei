import type { FilterExpr, LogQueryToken } from '@campfhir/bored-logs';
import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function log(n: number, minute: number, level: string, message: string) {
  return { log_id: String(n), logged_timestamp: at(minute), level, message };
}

function attr(
  n: number,
  minute: number,
  name: string,
  val: string | null,
  type: string,
  encrypted = false
) {
  return {
    log_id: String(n),
    logged_timestamp: at(minute),
    val_name: name,
    val,
    val_type: type,
    encrypted,
  };
}

const fixture = {
  logs: [
    log(1, 1, 'INFO', 'tool call ok'),
    log(2, 2, 'ERROR', 'tool call failed'),
    log(3, 3, 'WARN', 'slow_call 100%'),
    log(4, 4, 'DEBUG', 'Tool detail'),
    log(5, 5, 'INFO', 'signed in'),
    log(6, 60 * 24 * 3, 'INFO', 'days later'),
  ],
  log_attr: [
    attr(1, 1, 'accountId', 'acct-1', 'string'),
    attr(1, 1, 'tool', 'list_issues', 'string'),
    attr(1, 1, 'durationMs', '120', 'number'),
    attr(2, 2, 'accountId', 'acct-1', 'string'),
    attr(2, 2, 'tool', 'create_issue', 'string'),
    attr(2, 2, 'durationMs', '950', 'number'),
    attr(2, 2, 'request', JSON.stringify({ body: { key: 'ABC-1', n: 3 }, list: [1, 2] }), 'json'),
    attr(2, 2, 'payload', 'daolyap', 'string', true),
    attr(3, 3, 'accountId', 'acct-2', 'string'),
    attr(3, 3, 'when', '2026-01-01T00:03:00.000Z', 'date'),
    attr(3, 3, 'reason', null, 'null'),
    attr(4, 4, 'ok', 'true', 'boolean'),
    attr(5, 5, 'subject', 'ann', 'string'),
  ],
};

const leaf = (token: LogQueryToken): FilterExpr => ({ type: 'filter', filter: token });
const and = (...nodes: FilterExpr[]): FilterExpr => ({ type: 'and', nodes });
const or = (...nodes: FilterExpr[]): FilterExpr => ({ type: 'or', nodes });

/** A level name the adapter does not know, past the type that would refuse it. */
function unknownLevel(): 'info' {
  return JSON.parse('"loud"');
}

const window = { start: at(0).toISOString(), end: at(60 * 24).toISOString() };
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

export const activityLogScenarios: Scenario<DataStore>[] = [
  {
    method: 'activityLogs.search',
    name: 'window, levels, sort, limit and the parsed rows',
    fixture,
    run: async (store) => [
      await store.activityLogs.search({ ...window, sort: 'desc' }),
      ids(await store.activityLogs.search({ ...window, sort: 'asc', limit: 2, offset: 1 })),
      ids(await store.activityLogs.search({ ...window, levels: ['info', 'error'] })),
      ids(await store.activityLogs.search({ ...window, minLevel: 'warn' })),
      ids(
        await store.activityLogs.search({
          start: at(0).toISOString(),
          end: at(60 * 24 * 4).toISOString(),
        })
      ),
      ids(await store.activityLogs.search({ ...window, message: 'call' })),
      ids(await store.activityLogs.search({ ...window, message: '100%' })),
      ids(
        await store.activityLogs.search({ start: at(2).toISOString(), end: at(4).toISOString() })
      ),
      ids(await store.activityLogs.search({ ...window, attributeFilter: and() })),
      await store.activityLogs
        .search({ ...window, minLevel: undefined, level: unknownLevel() })
        .then(
          () => 'accepted',
          () => 'refused'
        ),
    ],
  },
  {
    method: 'activityLogs.search',
    name: 'attribute, message, level and timestamp leaves',
    fixture,
    run: async (store) => {
      const find = async (tree: FilterExpr) =>
        ids(await store.activityLogs.search({ ...window, attributeFilter: tree }));
      return [
        await find(and(or(leaf({ key: 'accountId', operator: 'contains', value: 'acct-1' })))),
        await find(and(or(leaf({ key: 'accountId', operator: '=', value: 'acct-2' })))),
        await find(
          and(or(leaf({ key: 'accountId', operator: 'contains', value: 'acct-1', negated: true })))
        ),
        await find(
          and(
            or(leaf({ key: 'tool', operator: 'contains', value: 'issue' })),
            or(leaf({ key: 'durationMs', operator: '>', value: '500' }))
          )
        ),
        await find(
          and(
            or(
              leaf({ key: 'tool', operator: '=', value: 'list_issues' }),
              leaf({ key: 'ok', operator: '=', value: 'true' })
            )
          )
        ),
        await find(and(or(leaf({ key: 'tool', operator: '<', value: 'd' })))),
        await find(and(or(leaf({ key: 'tool', operator: '<', value: 'd', cast: 'string' })))),
        await find(and(or(leaf({ key: 'when', operator: '>=', value: '2026-01-01T00:02:00Z' })))),
        await find(and(or(leaf({ key: 'reason', operator: '=', value: 'null', nullValue: true })))),
        await find(and(or(leaf({ key: 'request.body.key', operator: '=', value: 'ABC-1' })))),
        await find(and(or(leaf({ key: 'request.body.n', operator: '>=', value: '3' })))),
        await find(and(or(leaf({ key: 'request.list[1]', operator: '=', value: '2' })))),
        await find(and(or(leaf({ key: '$message', operator: 'contains', value: 'Tool' })))),
        await find(
          and(or(leaf({ key: '$message', operator: 'contains', value: 'tool', negated: true })))
        ),
        await find(and(or(leaf({ key: '$level', operator: '=', value: 'info' })))),
        await find(and(or(leaf({ key: '$level', operator: 'contains', value: 'r' })))),
        await find(and(or(leaf({ key: '$level', operator: '<=', value: 'warn' })))),
        await find(and(or(leaf({ key: '$level', operator: '>', value: 'info', negated: true })))),
        await find(and(or(leaf({ key: '$timestamp', operator: '>', value: at(3).toISOString() })))),
        await find(and(or(leaf({ key: '$timestamp', operator: '=', value: '2026-01-01' })))),
        await find(and(or(leaf({ key: '$timestamp', operator: '=', value: 'nonsense' })))),
        await find(and(or())),
      ];
    },
  },
  {
    method: 'activityLogs.search',
    name: 'secure() values decrypted with a cipher',
    fixture,
    run: async (store) => {
      const reverse = (text: string) => [...text].reverse().join('');
      const rows = await store.activityLogs.search(
        { ...window, levels: ['error'] },
        { encrypt: (text) => Buffer.from(reverse(text)), decrypt: reverse }
      );
      return rows.map((row) => row.meta.payload);
    },
  },
  {
    method: 'activityLogs.grantNamesByAccountIds',
    name: 'any provider, ordered; empty asks nothing',
    fixture: {
      provider_grants: ['atlassian', 'webex'].flatMap((provider) =>
        ['acct-1', 'acct-2'].map((account) => ({
          provider,
          provider_account_id: account,
          subject: 'ann',
          client_id: 'c',
          display_name: `${provider} ${account}`,
          encrypted_access_token: 'e',
          encrypted_refresh_token: 'e',
          expires_at: at(100),
        }))
      ),
    },
    run: async (store) => [
      await store.activityLogs.grantNamesByAccountIds(['acct-2', 'acct-9']),
      await store.activityLogs.grantNamesByAccountIds([]),
    ],
  },
  {
    method: 'activityLogs.writer',
    name: 'shipped records land with their attributes; below the level is dropped',
    run: async (store) => {
      const writer = store.activityLogs.writer({ level: 'info' });
      const record = (minute: number, level: string, message: string, attrs = {}) => ({
        level,
        message,
        template: message,
        secureMessage: false,
        attrs,
        timestamp: at(minute),
        application: 'worker',
        version: '1.2.3',
      });
      await writer.write(
        record(1, 'info', 'shipped one', {
          accountId: 'acct-1',
          count: 3,
          ok: true,
          when: at(0),
          detail: { a: 1 },
          none: null,
        })
      );
      await writer.write(record(2, 'error', 'shipped two', { application: 'own-app' }));
      await writer.write(record(3, 'debug', 'too chatty'));
      await writer.flush?.();
      await writer.close?.();
      return store.activityLogs.search({
        start: at(0).toISOString(),
        end: at(10).toISOString(),
        sort: 'asc',
      });
    },
  },
  {
    method: 'activityLogs.shippingRegistrations',
    name: 'set, replace, get and delete a shipper',
    run: async (store) => {
      const registrations = store.activityLogs.shippingRegistrations();
      const registration = {
        clientId: 'worker-1',
        signingKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x1', y: 'y1' },
        algo: 'ecdh-p256+a256gcm+ecdsa-p256',
        registeredAt: Date.UTC(2026, 0, 1),
      };
      await registrations.set(registration);
      const first = await registrations.get('worker-1');
      await registrations.set({ ...registration, signingKeyJwk: { kty: 'EC', x: 'x2' } });
      const replaced = await registrations.get('worker-1');
      await registrations.delete('worker-1');
      return { first, replaced, gone: await registrations.get('worker-1') };
    },
  },
];
