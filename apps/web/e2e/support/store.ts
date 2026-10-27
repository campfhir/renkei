/**
 * The data store, from a spec: every repository method the app calls,
 * run in the memory server's own store over app/api/test/data-store.
 *
 *   const store = dataStore(request);
 *   const agent = await store.agents.create({ ownerSubject, name, … });
 *
 * Each method takes the arguments the app passes and resolves to what the
 * app gets back (Dates revived; see lib/data-store-wire.ts), so a spec
 * seeds exactly what the application writes — never raw table rows. Many
 * calls in one round trip go through `dataStoreBatch`.
 *
 * Only on a server running RENKEI_DATA_STORE=memory with the seed token
 * (playwright.memory.config.ts); anything else answers 404.
 */

import type { APIRequestContext } from '@playwright/test';
import type { DataStore } from '@renkei/db';
import { decodeWire, encodeWire, type WireCall } from '../../lib/data-store-wire';
import { MEMORY_BASE_URL, MEMORY_SEED_TOKEN } from '../memory/constants';

export const DATA_STORE_URL = `${MEMORY_BASE_URL}/api/test/data-store`;
export const DATA_STORE_HEADERS = { 'x-renkei-seed-token': MEMORY_SEED_TOKEN };

type Remote<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

/** One repository, each method answering over the wire. */
export type RemoteRepository<R> = {
  [K in keyof R as R[K] extends (...args: never[]) => unknown ? K : never]: Remote<R[K]>;
};

/** `DataStore` as a spec sees it: every domain, every method a promise. */
export type RemoteDataStore = {
  [D in Exclude<keyof DataStore, 'kind'>]: RemoteRepository<DataStore[D]>;
};

/** Run calls in order on the server; answers each call's result. */
export async function callDataStore(
  request: APIRequestContext,
  calls: readonly WireCall[]
): Promise<unknown[]> {
  const response = await request.post(DATA_STORE_URL, {
    headers: DATA_STORE_HEADERS,
    data: {
      calls: calls.map((call) => ({
        method: call.method,
        args: encodeWire(call.args),
        ...(call.at ? { at: call.at.toISOString() } : {}),
      })),
    },
  });
  const text = await response.text();
  if (response.status() !== 200) {
    throw new Error(`data store ${response.status()}: ${text}`);
  }
  const body: unknown = decodeWire(JSON.parse(text));
  const results =
    typeof body === 'object' && body !== null && 'results' in body ? body.results : null;
  if (!Array.isArray(results) || results.length !== calls.length) {
    throw new Error(`data store answered something else: ${text}`);
  }
  return results;
}

/**
 * A two-level proxy, `domain.method(...args)`, every call handed to
 * `send`. `then` and symbols answer undefined, so neither level reads as
 * a promise when awaited or returned from an async function.
 */
function remoteStore(send: (call: WireCall) => Promise<unknown>, at?: Date): RemoteDataStore {
  const level = <T extends object>(get: (key: string) => unknown): T =>
    new Proxy<T>(Object.create(null), {
      get: (_target, key) => (typeof key === 'string' && key !== 'then' ? get(key) : undefined),
    });
  return level<RemoteDataStore>((domain) =>
    level(
      (method) =>
        (...args: unknown[]) =>
          send({ method: `${domain}.${method}`, args, ...(at ? { at } : {}) })
    )
  );
}

/**
 * The store, one round trip per call. With `at`, every call runs as of
 * that moment: the "now" the store stamps (a run's created_at, a ledger
 * row's date, "finished now") reads it — yesterday's fixture, written by
 * today's methods.
 */
export function dataStore(
  request: APIRequestContext,
  options: { at?: Date } = {}
): RemoteDataStore {
  return remoteStore(async (call) => (await callDataStore(request, [call]))[0], options.at);
}

export interface DataStoreBatch {
  /** Queue calls; each promise settles once `send` has run the batch. */
  store: RemoteDataStore;
  /** The same queue, each call run as of `at` (see `dataStore`). */
  asOf(at: Date): RemoteDataStore;
  /** Run every queued call, in the order queued, in one round trip. */
  send(): Promise<void>;
}

/**
 * Many calls in one round trip, for a big fixture. A call's arguments
 * cannot depend on an earlier call's answer in the same batch — choose
 * ids up front (the store methods take them), or send twice.
 */
export function dataStoreBatch(request: APIRequestContext): DataStoreBatch {
  let queued: {
    call: WireCall;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const enqueue = (call: WireCall): Promise<unknown> => {
    const settled = new Promise<unknown>((resolve, reject) => {
      queued.push({ call, resolve, reject });
    });
    // A caller that only awaits `send` must not leave a rejection unhandled.
    settled.catch(() => {});
    return settled;
  };
  return {
    store: remoteStore(enqueue),
    asOf: (at) => remoteStore(enqueue, at),
    send: async () => {
      const batch = queued;
      queued = [];
      if (batch.length === 0) return;
      try {
        const results = await callDataStore(
          request,
          batch.map((entry) => entry.call)
        );
        batch.forEach((entry, index) => entry.resolve(results[index]));
      } catch (error) {
        for (const entry of batch) entry.reject(error);
        throw error;
      }
    },
  };
}

/** Forget one subject's rows (what they own, and what cascades), or everything. */
export async function forgetSubject(request: APIRequestContext, subject: string): Promise<void> {
  const response = await request.delete(DATA_STORE_URL, {
    headers: DATA_STORE_HEADERS,
    data: { subject },
  });
  if (response.status() !== 200) {
    throw new Error(`data store ${response.status()}: ${await response.text()}`);
  }
}
