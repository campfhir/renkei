/**
 * A data store with no database behind it: every repository call is sent
 * to another process that has one, and its answer returned.
 *
 * This is what a sandbox uses (docs/sandbox-orchestrator-design.md). A
 * sandbox runs other people's code, so it holds no database URL and no
 * route to Postgres: its worker still reads and writes through
 * `getDataStore()`, as every process does, but the store registered there
 * is this one, and each call goes to the orchestrator — which decides
 * whether that sandbox may make it (`dispatchStoreCall` and its policy:
 * the repositories the sandbox database role was granted, every call
 * held to the subjects that sandbox serves) and runs it on its own store.
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
function isJsonObject(value: unknown): value is Record<string, unknown> {
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
  if (isJsonObject(value)) {
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
  if (!isJsonObject(value)) return value;
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

/** The sandbox that is calling: what it is for, and whom it serves. */
export interface StoreCaller {
  /** `system` is the sandbox of calls made for no caller; it serves no subject. */
  kind: 'user' | 'agent' | 'project' | 'system';
  /**
   * The subjects whose rows it may touch: the people, and the code
   * project, it has been asked to work for (`sandboxes.subjects`).
   */
  subjects: readonly string[];
}

type Owners = (store: DataStore, ids: string[]) => Promise<string[]>;

/**
 * How one repository method is held to the calling sandbox's own scope.
 *
 *  - `open`: nothing of any one subject's — the organization's settings,
 *    a count for a batch whose id the caller already holds.
 *  - `system`: the organization's own rows (the image allow-list), which
 *    only the system sandbox changes.
 *  - `subject`: the argument at `arg` is the subject, or an object whose
 *    `subject` is: it must be one the sandbox serves.
 *  - `owned`: the argument at `arg` is a row's id (or ids). Whose rows
 *    they are is looked up first, and every owner must be one the sandbox
 *    serves. An id with no row is nobody's, and the call goes through to
 *    find nothing.
 *  - `rows`: a read across subjects (what has expired). It runs, and only
 *    the rows of subjects the sandbox serves are answered.
 *  - `custom`: answered here, from calls that are themselves scoped.
 */
type Guard =
  | { kind: 'open' }
  | { kind: 'system' }
  | { kind: 'subject'; arg: number }
  | { kind: 'owned'; arg: number; owners: Owners }
  | { kind: 'rows' }
  | {
      kind: 'custom';
      run: (store: DataStore, caller: StoreCaller, args: unknown[]) => Promise<unknown>;
    };

export type StorePolicy = Readonly<Record<string, Readonly<Record<string, Guard>>>>;

const OPEN: Guard = { kind: 'open' };
const SYSTEM: Guard = { kind: 'system' };
const ROWS: Guard = { kind: 'rows' };
const subject = (arg: number): Guard => ({ kind: 'subject', arg });
const owned = (arg: number, owners: Owners): Guard => ({ kind: 'owned', arg, owners });

const fileOwners: Owners = (store, ids) => store.sandboxFiles.subjectsOf(ids);
const serviceOwners: Owners = (store, ids) => store.sandboxServices.subjectsOf(ids);
const secretOwners: Owners = (store, ids) => store.sandboxSecrets.subjectsOf(ids);
const envSecretOwners: Owners = (store, ids) => store.sandboxEnvSecrets.subjectsOf(ids);
const workspaceOwners: Owners = async (store, ids) => {
  const rows = await Promise.all(ids.map((id) => store.sandboxWorkspaces.getById(id)));
  return rows.flatMap((row) => (row ? [row.subject] : []));
};
const crawlOwners: Owners = async (store, ids) => {
  const rows = await Promise.all(ids.map((id) => store.sandboxCrawls.getById(id)));
  return rows.flatMap((row) => (row ? [row.subject] : []));
};

/**
 * What a sandbox may ask of the store, and how each call is held to that
 * sandbox's own scope. The repositories are the ones the sandbox database
 * role was granted (roles.ts, SANDBOX_TABLE_GRANTS) — its files,
 * checkouts, services, secrets and crawls, the organization's settings
 * and a checkout's approved size to read — and every method is listed:
 * one that is not here is refused, so a new method is unreachable from a
 * sandbox until someone decides how it is scoped.
 *
 * Two calls reach across subjects by design, and only ever answer a
 * number: the crawls' housekeeping (`releaseStale`, `sweepExpired`),
 * which acts on rows that are already abandoned or expired.
 */
export const SANDBOX_STORE_POLICY: StorePolicy = {
  sandboxFiles: {
    insert: subject(0),
    list: subject(0),
    countForSubject: subject(0),
    totalBytesForSubject: subject(0),
    countForBatch: OPEN,
    totalBytesForBatch: OPEN,
    get: subject(0),
    delete: subject(0),
    listExpired: ROWS,
    deleteById: owned(0, fileOwners),
    subjectsOf: owned(0, fileOwners),
  },
  sandboxWorkspaces: {
    insert: subject(0),
    list: subject(0),
    count: subject(0),
    get: subject(0),
    setStatus: owned(0, workspaceOwners),
    listWorktrees: subject(0),
    touch: owned(0, workspaceOwners),
    delete: subject(0),
    listExpired: ROWS,
    deleteById: owned(0, workspaceOwners),
    getById: owned(0, workspaceOwners),
    listWorktreesOf: owned(0, workspaceOwners),
  },
  sandboxServices: {
    insert: subject(0),
    list: subject(0),
    getByName: subject(0),
    update: owned(0, serviceOwners),
    touch: owned(0, serviceOwners),
    deleteById: owned(0, serviceOwners),
    listExpired: ROWS,
    // The containers the sandbox's own subjects claim: what its own engine may hold.
    listClaimedContainerIds: {
      kind: 'custom',
      run: async (store, caller) => {
        const lists = await Promise.all(
          caller.subjects.map((served) => store.sandboxServices.list(served))
        );
        return lists
          .flat()
          .flatMap((service) => (service.containerId ? [service.containerId] : []))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      },
    },
    subjectsOf: owned(0, serviceOwners),
  },
  sandboxSecrets: {
    insert: subject(0),
    list: subject(0),
    count: subject(0),
    get: subject(0),
    getByName: subject(0),
    touchUsed: owned(0, secretOwners),
    delete: subject(0),
    // Expired ids, of the subjects the sandbox serves only.
    listExpiredIds: {
      kind: 'custom',
      run: async (store, caller, args) => {
        const [before, limit] = args;
        if (!(before instanceof Date) || typeof limit !== 'number') {
          throw new StoreCallRefused('sandboxSecrets.listExpiredIds takes a date and a limit');
        }
        const ids = await store.sandboxSecrets.listExpiredIds(before, limit);
        const kept: string[] = [];
        for (const id of ids) {
          const owners = await store.sandboxSecrets.subjectsOf([id]);
          if (owners.every((owner) => caller.subjects.includes(owner))) kept.push(id);
        }
        return kept;
      },
    },
    deleteById: owned(0, secretOwners),
    subjectsOf: owned(0, secretOwners),
  },
  sandboxEnvSecrets: {
    upsert: subject(0),
    list: subject(0),
    count: subject(0),
    has: subject(0),
    listSealed: subject(0),
    touchUsed: owned(0, envSecretOwners),
    delete: subject(0),
    subjectsOf: owned(0, envSecretOwners),
  },
  sandboxCrawls: {
    create: subject(0),
    get: subject(0),
    getById: owned(0, crawlOwners),
    list: subject(0),
    transition: owned(0, crawlOwners),
    progress: owned(0, crawlOwners),
    extend: owned(0, crawlOwners),
    putPage: owned(0, crawlOwners),
    visitedUrls: owned(0, crawlOwners),
    pages: subject(0),
    saveRecipe: subject(0),
    recipe: subject(0),
    recipes: subject(0),
    releaseStale: OPEN,
    sweepExpired: OPEN,
  },
  codeServiceImageRules: {
    list: OPEN,
    count: OPEN,
    listForMatching: OPEN,
    insert: SYSTEM,
    update: SYSTEM,
    delete: SYSTEM,
    insertMissing: SYSTEM,
  },
  settings: { all: OPEN, get: OPEN },
  codeProjects: { approvedSizes: subject(0) },
};

/** A call that is not allowed, is not this sandbox's, or names nothing the store has. */
export class StoreCallRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreCallRefused';
  }
}

/** A repository's own method, by name: nothing inherited, nothing that is not a function. */
function methodOf(
  store: DataStore,
  call: StoreCall
): { repository: object; method: (...args: unknown[]) => unknown } {
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
  return {
    repository,
    method: (...args: unknown[]): unknown => Reflect.apply(method, repository, args),
  };
}

function subjectOfRow(row: unknown): string | null {
  return isJsonObject(row) && typeof row.subject === 'string' ? row.subject : null;
}

/**
 * Run one call from a sandbox on `store`, if `policy` admits it and it is
 * within what `caller` serves. Refused otherwise — the same refusal
 * whether the method is unknown, not allowed, or another scope's, so a
 * refusal says nothing about what exists.
 */
export async function dispatchStoreCall(
  store: DataStore,
  policy: StorePolicy,
  call: StoreCall,
  caller: StoreCaller
): Promise<unknown> {
  const name = `${call.domain}.${call.method}`;
  const methods = Object.hasOwn(policy, call.domain) ? policy[call.domain] : undefined;
  const guard = methods && Object.hasOwn(methods, call.method) ? methods[call.method] : undefined;
  if (!guard) throw new StoreCallRefused(`${name} is not a call a sandbox may make`);
  const outside = (): StoreCallRefused =>
    new StoreCallRefused(`${name} was asked for a scope this sandbox does not serve`);
  const serves = (candidate: unknown): boolean =>
    typeof candidate === 'string' && caller.subjects.includes(candidate);

  if (guard.kind === 'custom') return guard.run(store, caller, call.args);
  const { method } = methodOf(store, call);

  if (guard.kind === 'system' && caller.kind !== 'system') {
    throw new StoreCallRefused(`${name} is the organization’s, not a sandbox’s, to change`);
  }
  if (guard.kind === 'subject') {
    const arg = call.args[guard.arg];
    if (!serves(isJsonObject(arg) ? arg.subject : arg)) throw outside();
  }
  if (guard.kind === 'owned') {
    const arg = call.args[guard.arg];
    const ids = Array.isArray(arg) ? arg : [arg];
    if (!ids.every((id): id is string => typeof id === 'string')) throw outside();
    const owners = await guard.owners(store, ids);
    if (!owners.every(serves)) throw outside();
  }
  const answer = await method(...call.args);
  if (guard.kind === 'rows') {
    return Array.isArray(answer) ? answer.filter((row) => serves(subjectOfRow(row))) : [];
  }
  return answer;
}

/**
 * `value` without its trailing slashes. A loop, not `/\/+$/`: on a long
 * run of slashes that does not end the string, that expression backtracks
 * over it again and again, and these values come from outside.
 */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
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
  const endpoint = `${withoutTrailingSlashes(options.url)}/sandbox/v1/store`;
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
    if (isJsonObject(body) && body.ok === true) return decodeWire(body.result);
    const error = isJsonObject(body) && isJsonObject(body.error) ? body.error : {};
    throw new RemoteStoreError(
      typeof error.message === 'string'
        ? error.message
        : `the orchestrator answered ${response.status} to ${call.domain}.${call.method}`,
      typeof error.code === 'string' ? error.code : undefined,
      typeof error.constraint === 'string' ? error.constraint : undefined
    );
  };
}
