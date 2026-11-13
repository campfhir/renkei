/**
 * A data store with no database behind it: every repository call is sent
 * to another process that has one, and its answer returned.
 *
 * This is what a sandbox uses (docs/sandbox-orchestrator-design.md). A
 * sandbox runs other people's code, so it holds no database URL and no
 * route to Postgres: its worker still reads and writes through
 * `getDataStore()`, as every process does, but the store registered there
 * is this one, and each call goes to the orchestrator — which decides
 * whether that sandbox may make it (`dispatchStoreCall`'s allow-list: the
 * repositories the sandbox database role was granted, and no others) and
 * runs it on its own store.
 *
 * The wire is JSON with the few values JSON has no word for written as
 * tagged objects (`encodeWire` / `decodeWire`): a Date, bytes, a bigint.
 * `undefined` travels as absent, as it does into a SQL statement. A
 * refusal a caller acts on — a duplicate's SQLSTATE — comes back as the
 * thrown error's `code`, so the callers that check for 23505 still do.
 */

import type { DataStore } from './types';

/** One repository call, as it is sent. */
export interface StoreCall {
  domain: string;
  method: string;
  args: unknown[];
}

/** How a call reaches the process that has the database; resolves to the decoded answer. */
export type StoreTransport = (call: StoreCall) => Promise<unknown>;

type Tagged = { $date: string } | { $bytes: string } | { $bigint: string };

/**
 * A plain object — one JSON would write as `{…}` — wherever it was made:
 * parsed JSON can come from another realm, whose `Object.prototype` is
 * not this one's, so the prototype is known by what it is, not which.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === null) return true;
  // The root prototype: nothing above it. A class instance has one more.
  return Object.getPrototypeOf(proto) === null;
}

/** A value as JSON can carry it: Dates, bytes and bigints tagged, the rest as it is. */
export function encodeWire(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    const tagged: Tagged = { $date: value.toISOString() };
    return tagged;
  }
  if (typeof value === 'bigint') {
    const tagged: Tagged = { $bigint: value.toString() };
    return tagged;
  }
  if (value instanceof Uint8Array) {
    const tagged: Tagged = { $bytes: Buffer.from(value).toString('base64') };
    return tagged;
  }
  if (Array.isArray(value)) return value.map(encodeWire);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = encodeWire(entry);
    }
    return out;
  }
  if (typeof value === 'object') {
    throw new Error('a store call can only carry plain data');
  }
  return value;
}

/** The value `encodeWire` was given, back from its JSON. */
export function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire);
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    if (typeof value.$date === 'string') return new Date(value.$date);
    if (typeof value.$bigint === 'string') return BigInt(value.$bigint);
    if (typeof value.$bytes === 'string') return Buffer.from(value.$bytes, 'base64');
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = decodeWire(entry);
  return out;
}

/** An error from the far side, with the `code` a caller may check. */
export class RemoteStoreError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly constraint?: string
  ) {
    super(message);
    this.name = 'RemoteStoreError';
  }
}

/**
 * The store whose every call goes through `transport`. Any repository and
 * any method can be named here; whether the call is allowed is the far
 * side's to say, and a refused one rejects like a failed query.
 */
export function createRemoteDataStore(transport: StoreTransport): DataStore {
  const domains = new Map<string, object>();
  const domainOf = (domain: string): object => {
    const known = domains.get(domain);
    if (known) return known;
    const made = new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== 'string') return undefined;
          return (...args: unknown[]) => transport({ domain, method, args });
        },
      }
    );
    domains.set(domain, made);
    return made;
  };
  const store = new Proxy(
    { kind: 'remote' },
    {
      get(target, property) {
        if (property === 'kind') return target.kind;
        // Not a thenable, not a memory store: only repositories live here.
        if (typeof property !== 'string' || property === 'then') return undefined;
        return domainOf(property);
      },
      has(_target, property) {
        return property === 'kind';
      },
    }
  );
  // The proxy answers every repository the DataStore type names, by
  // forwarding it: that is the whole of this implementation, and no type
  // can say so of a Proxy.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return store as unknown as DataStore;
}

/**
 * Which calls a remote caller may make: a repository's every method
 * (`'all'`), or the ones named.
 */
export type StoreAllowList = Readonly<Record<string, 'all' | readonly string[]>>;

/**
 * What a sandbox may ask of the store: exactly the repositories the
 * sandbox database role was granted (roles.ts, SANDBOX_TABLE_GRANTS) —
 * the sandbox's own tables in full, the organization's settings and a
 * checkout's approved size to read — and nothing about people, chats,
 * agents, grants or keys.
 */
export const SANDBOX_STORE_ALLOW_LIST: StoreAllowList = {
  sandboxFiles: 'all',
  sandboxWorkspaces: 'all',
  sandboxServices: 'all',
  sandboxSecrets: 'all',
  sandboxEnvSecrets: 'all',
  sandboxCrawls: 'all',
  codeServiceImageRules: 'all',
  settings: ['all', 'get'],
  codeProjects: ['approvedSizes'],
};

/** A call that is not on the list, or names nothing the store has. */
export class StoreCallRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreCallRefused';
  }
}

/**
 * Run one remote call on `store` if `allow` admits it. The method must be
 * a repository's own function: nothing inherited, nothing that is not a
 * function, is ever reached by name.
 */
export async function dispatchStoreCall(
  store: DataStore,
  allow: StoreAllowList,
  call: StoreCall
): Promise<unknown> {
  const allowed = Object.hasOwn(allow, call.domain) ? allow[call.domain] : undefined;
  if (!allowed || (allowed !== 'all' && !allowed.includes(call.method))) {
    throw new StoreCallRefused(`${call.domain}.${call.method} is not a call a sandbox may make`);
  }
  const repository: unknown = Reflect.get(store, call.domain);
  if (
    typeof repository !== 'object' ||
    repository === null ||
    !Object.hasOwn(repository, call.method)
  ) {
    throw new StoreCallRefused(`the store has no ${call.domain}.${call.method}`);
  }
  const method: unknown = Reflect.get(repository, call.method);
  if (typeof method !== 'function') {
    throw new StoreCallRefused(`the store has no ${call.domain}.${call.method}`);
  }
  return Reflect.apply(method, repository, call.args);
}

/**
 * The transport a sandbox's worker uses: each call POSTed to the
 * orchestrator's `/sandbox/v1/store`, as that sandbox (its id, and its
 * own key as the bearer). A refusal or a failed call rejects with the far
 * side's words, and with the `code` it named.
 */
export function createHttpStoreTransport(options: {
  /** The orchestrator's address as the sandbox reaches it. */
  url: string;
  sandboxId: string;
  sandboxKey: string;
  timeoutMs?: number;
}): StoreTransport {
  const endpoint = `${options.url.replace(/\/+$/, '')}/sandbox/v1/store`;
  return async (call) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.sandboxKey}`,
        'x-sandbox-id': options.sandboxId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        domain: call.domain,
        method: call.method,
        args: encodeWire(call.args),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (isPlainObject(body) && body.ok === true) return decodeWire(body.result);
    const error = isPlainObject(body) && isPlainObject(body.error) ? body.error : {};
    throw new RemoteStoreError(
      typeof error.message === 'string'
        ? error.message
        : `the orchestrator answered ${response.status} to ${call.domain}.${call.method}`,
      typeof error.code === 'string' ? error.code : undefined,
      typeof error.constraint === 'string' ? error.constraint : undefined
    );
  };
}
