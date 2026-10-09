/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The generic HTTP seam every egress worker's server.ts builds on:
 * bearer auth (constant-time, fails closed on no keys), a size-capped
 * body read, and the health/auth/method/op/body dispatch chain
 * `createJsonRpcServer` wraps around a connector's own `handlers` map.
 * The per-connector error vocabulary (WorkerErrorType/statusForError)
 * is exercised in each worker's own server.test.ts, not here.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import {
  authorized,
  isRecord,
  matchApiKey,
  parseNamedApiKeys,
  readBody,
  sendJson,
  str,
  createJsonRpcServer,
} from './http';

describe('isRecord', () => {
  it('accepts a plain object, rejects everything else', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('str', () => {
  it('passes a string through and coerces everything else to empty', () => {
    expect(str('hi')).toBe('hi');
    expect(str('')).toBe('');
    expect(str(1)).toBe('');
    expect(str(null)).toBe('');
    expect(str(undefined)).toBe('');
  });
});

/** A minimal stand-in for IncomingMessage — just enough for authorized()
 *  (headers) and readBody() (the data/end/error event contract). */
function fakeRequest(headers: Record<string, string> = {}): EventEmitter & {
  headers: Record<string, string>;
} {
  const emitter = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
  emitter.headers = headers;
  return emitter;
}

describe('authorized', () => {
  it('refuses when no keys are configured — fail closed, never open', () => {
    const request = fakeRequest({ authorization: 'Bearer anything' });
    expect(authorized(request as never, [])).toBe(false);
  });

  it('refuses a missing or malformed Authorization header', () => {
    expect(authorized(fakeRequest() as never, ['k'])).toBe(false);
    expect(authorized(fakeRequest({ authorization: 'k' }) as never, ['k'])).toBe(false);
  });

  it('accepts any one of several configured keys, refuses a wrong one', () => {
    const request = fakeRequest({ authorization: 'Bearer second-key' });
    expect(authorized(request as never, ['first-key', 'second-key'])).toBe(true);
    const wrong = fakeRequest({ authorization: 'Bearer nope' });
    expect(authorized(wrong as never, ['first-key', 'second-key'])).toBe(false);
  });
});

describe('matchApiKey', () => {
  const keys = [{ name: 'web', key: 'web-key' }, { name: 'agents', key: 'agents-key' }, 'plain'];

  it('names the caller whose key was presented; a plain string is the default caller', () => {
    expect(matchApiKey(fakeRequest({ authorization: 'Bearer agents-key' }) as never, keys)).toEqual(
      {
        name: 'agents',
        key: 'agents-key',
      }
    );
    expect(matchApiKey(fakeRequest({ authorization: 'Bearer plain' }) as never, keys)).toEqual({
      name: 'default',
      key: 'plain',
    });
    expect(matchApiKey(fakeRequest({ authorization: 'Bearer nope' }) as never, keys)).toBeNull();
    expect(matchApiKey(fakeRequest({ authorization: 'Bearer web-key' }) as never, [])).toBeNull();
  });
});

describe('parseNamedApiKeys', () => {
  it('reads name=key pairs and files the plain keys under the default caller', () => {
    expect(
      parseNamedApiKeys(
        {
          X_API_KEYS: 'web=w1, agents=a1,bad entry,=nokey,worker=',
          X_API_KEY: 'shared-1,shared-2',
        },
        'X',
        'web'
      )
    ).toEqual([
      { name: 'web', key: 'w1' },
      { name: 'agents', key: 'a1' },
      { name: 'web', key: 'shared-1' },
      { name: 'web', key: 'shared-2' },
    ]);
    expect(parseNamedApiKeys({}, 'X')).toEqual([]);
  });
});

describe('readBody', () => {
  it('collects chunks into one buffer', async () => {
    const request = fakeRequest();
    const promise = readBody(request as never, 1024);
    request.emit('data', Buffer.from('{"a":'));
    request.emit('data', Buffer.from('1}'));
    request.emit('end');
    expect((await promise)?.toString('utf8')).toBe('{"a":1}');
  });

  it('resolves null once the cap is exceeded, rather than buffering past it', async () => {
    const request = fakeRequest();
    const promise = readBody(request as never, 4);
    request.emit('data', Buffer.from('12345'));
    expect(await promise).toBeNull();
  });

  it('rejects on a stream error', async () => {
    const request = fakeRequest();
    const promise = readBody(request as never, 1024);
    request.emit('error', new Error('boom'));
    await expect(promise).rejects.toThrow('boom');
  });
});

const API_KEY = 'test-key';
const NARROW_KEY = 'narrow-key';

function statusForError(type: string): number {
  switch (type) {
    case 'bad_request':
      return 400;
    case 'unauthorized':
      return 401;
    case 'unknown_operation':
      return 404;
    case 'method_not_allowed':
      return 405;
    case 'forbidden':
      return 403;
    case 'too_large':
      return 413;
    default:
      return 500;
  }
}

describe('createJsonRpcServer', () => {
  let server: Server;
  let base: string;
  let unhandled: unknown[];

  beforeAll(async () => {
    unhandled = [];
    server = createJsonRpcServer({
      apiKeys: [API_KEY, { name: 'narrow', key: NARROW_KEY }],
      maxBodyBytes: 32,
      handlers: {
        echo: async (body, response, context) =>
          sendJson(response, 200, { got: body, caller: context.caller }),
        throws: async () => {
          throw new Error('handler blew up');
        },
      },
      allowOp: (caller, op) => caller === 'default' || op === 'echo',
      sendError: (response, type, message) =>
        sendJson(response, statusForError(type), { error: { type, message } }),
      onUnhandledError: (error) => unhandled.push(error),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  function post(path: string, body: unknown, key: string | null = API_KEY): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('serves /health without a key', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('refuses a missing or wrong key', async () => {
    for (const key of [null, 'wrong']) {
      const response = await post('/v1/echo', {}, key);
      expect(response.status).toBe(401);
    }
  });

  it('refuses a GET on an op route', async () => {
    const response = await fetch(`${base}/v1/echo`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.status).toBe(405);
  });

  it('refuses an unknown op', async () => {
    const response = await post('/v1/bogus', {});
    expect(response.status).toBe(404);
  });

  it('refuses a body over the cap', async () => {
    const response = await post('/v1/echo', { padding: 'x'.repeat(64) });
    expect(response.status).toBe(413);
  });

  it('refuses invalid JSON and a non-object body alike', async () => {
    expect((await post('/v1/echo', 'not json')).status).toBe(400);
    expect((await post('/v1/echo', '[]')).status).toBe(400);
  });

  it('dispatches a valid call to its handler, naming the caller', async () => {
    const response = await post('/v1/echo', { hello: 'world' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ got: { hello: 'world' }, caller: 'default' });
  });

  it("refuses an op the matched key's caller may not run, before reading the body", async () => {
    const allowed = await post('/v1/echo', { hi: 1 }, NARROW_KEY);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ got: { hi: 1 }, caller: 'narrow' });
    const refused = await post('/v1/throws', { padding: 'x'.repeat(64) }, NARROW_KEY);
    expect(refused.status).toBe(403);
    expect(unhandled).toHaveLength(0);
  });

  it('answers 500 and reports a handler that throws, without hanging the response', async () => {
    const response = await post('/v1/throws', {});
    expect(response.status).toBe(500);
    expect(unhandled).toHaveLength(1);
  });
});
