/**
 * The connector workers, reached through the delegate (decision 2 in
 * docs/delegate-key-design.md). Mirth Connect, ADManager Plus and the
 * network file shares live on private networks that only their own
 * workers dial; OnBase's IdP and API likewise. Those workers used to open
 * a person's stored credential themselves. Now the delegate opens it —
 * it is the one process that holds a key — and attaches it to the request
 * it forwards, so a connector worker holds a credential only in flight.
 *
 * Ops: `forward/<connector>/<op>`, the op being the worker's own:
 *   mirth       api, logout (credentialed); test-connection, probe (through)
 *   admanager   api (credentialed); test-connection, probe (through)
 *   fileshares  list, stat, read, mkdir, remove, remove-preview, move,
 *               rename (credentialed, JSON); write (credentialed, raw body
 *               with the target in the query string); test-connection (through)
 *   onbase      api, content, put-bytes (the person's OAuth access token
 *               attached, by subject); discover, test-connection (through).
 *               token and revoke are not forwarded: exchange, refresh and
 *               revocation are the delegate's own (grants.ts).
 *
 * The answer is relayed as the worker gave it — status, headers and body —
 * so the web-side clients read exactly what they read before.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  parseMirthCredentials,
  readConnectionCiphertext as readMirthCiphertext,
} from '@renkei/connector-mirth';
import {
  parseAdManagerCredentials,
  readConnectionCiphertext as readAdManagerCiphertext,
} from '@renkei/connector-admanager';
import {
  parseShareCredentials,
  readConnectionCiphertext as readShareCiphertext,
  type ShareCredentials,
} from '@renkei/connector-fileshares';
import { openForSubject } from '@renkei/user-keys';
import { isRecord, readBody, sendJson, str } from '@renkei/worker-kit';
import type { Grants } from './grants';

const MAX_JSON_BYTES = 16 * 1_048_576;
/** A file written to a share; the worker applies the org's own transfer cap after this one. */
const MAX_RAW_BYTES = 512 * 1_048_576;
const TIMEOUT_MS = 10 * 60_000;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-encoding',
  'content-length',
]);

type Connector = 'mirth' | 'admanager' | 'fileshares' | 'onbase';

const CONNECTORS: Record<
  Connector,
  { envPrefix: string; credentialed: readonly string[]; through: readonly string[] }
> = {
  mirth: {
    envPrefix: 'MIRTH_WORKER',
    credentialed: ['api', 'logout'],
    through: ['test-connection', 'probe'],
  },
  admanager: {
    envPrefix: 'ADMANAGER_WORKER',
    credentialed: ['api'],
    through: ['test-connection', 'probe'],
  },
  fileshares: {
    envPrefix: 'FILESHARES_WORKER',
    credentialed: [
      'list',
      'stat',
      'read',
      'mkdir',
      'remove',
      'remove-preview',
      'move',
      'rename',
      'write',
    ],
    through: ['test-connection'],
  },
  onbase: {
    envPrefix: 'ONBASE_WORKER',
    credentialed: ['api', 'content', 'put-bytes'],
    through: ['discover', 'test-connection'],
  },
};

function connectorOf(value: string): Connector | null {
  return value === 'mirth' || value === 'admanager' || value === 'fileshares' || value === 'onbase'
    ? value
    : null;
}

function workerConfig(prefix: string): { url: string; apiKey: string } | null {
  const url = process.env[`${prefix}_URL`]?.trim().replace(/\/+$/, '');
  const apiKey = process.env[`${prefix}_API_KEY`]?.trim();
  return url && apiKey ? { url, apiKey } : null;
}

function fail(response: ServerResponse, status: number, type: string, message?: string): void {
  sendJson(response, status, { error: { type, message } });
}

/** Relay the worker's answer verbatim: status, headers (minus the wire's own), body streamed. */
async function relay(upstream: Response, response: ServerResponse): Promise<void> {
  response.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) response.setHeader(name, value);
  });
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(value)) {
        await new Promise<void>((resolve) => response.once('drain', resolve));
      }
    }
    response.end();
  } catch {
    response.destroy();
  }
}

export class Forwarder {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly grants: Grants,
    /** Injected in tests; production dials the worker. */
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  /** `forward/<connector>/<op>`; anything else is not this module's. */
  async handle(op: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const match = /^forward\/([a-z]+)\/([a-z-]+)$/.exec(op);
    if (!match) return false;
    const connector = connectorOf(match[1]);
    const workerOp = match[2];
    if (!connector) return false;
    const spec = CONNECTORS[connector];
    if (!spec.credentialed.includes(workerOp) && !spec.through.includes(workerOp)) {
      fail(response, 404, 'unknown_operation');
      return true;
    }
    const worker = workerConfig(spec.envPrefix);
    if (!worker) {
      fail(
        response,
        503,
        'unconfigured',
        `${spec.envPrefix}_URL and _API_KEY are not set on the delegate`
      );
      return true;
    }
    const url = new URL(request.url ?? '/', 'http://delegate.internal');

    // The two raw ops: a file's bytes in (fileshares write) and OnBase's chunked upload.
    if (connector === 'fileshares' && workerOp === 'write') {
      await this.forwardShareWrite(worker, url, request, response);
      return true;
    }
    if (connector === 'onbase' && workerOp === 'put-bytes') {
      await this.forwardOnBasePutBytes(worker, url, request, response);
      return true;
    }

    const raw = await readBody(request, MAX_JSON_BYTES);
    if (raw === null) {
      fail(response, 413, 'too_large');
      return true;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      fail(response, 400, 'bad_request');
      return true;
    }
    if (!isRecord(body)) {
      fail(response, 400, 'bad_request');
      return true;
    }
    // Whatever a caller put there, the credential is this process's to supply.
    delete body.credentials;

    if (spec.credentialed.includes(workerOp)) {
      const attached = await this.attach(connector, body);
      if (!attached.ok) {
        fail(response, attached.status, attached.type, attached.message);
        return true;
      }
    }
    await this.send(worker, workerOp, response, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return true;
  }

  /** Open the person's credential for the target the body names and put it on the body. */
  private async attach(
    connector: Connector,
    body: Record<string, unknown>
  ): Promise<{ ok: true } | { ok: false; status: number; type: string; message?: string }> {
    const subject = str(body.subject);
    if (!subject) {
      return {
        ok: false,
        status: 400,
        type: 'bad_request',
        message: 'tenantId and subject are required',
      };
    }
    if (connector === 'onbase') {
      const connectorName = str(body.connector) || 'onbase';
      const access = await this.grants.accessFor(connectorName, { subject });
      if (!access.ok) return { ok: false, status: access.status, type: access.error };
      body.accessToken = access.token;
      return { ok: true };
    }
    const id = str(connector === 'fileshares' ? body.shareId : body.instanceId);
    if (!id) {
      return {
        ok: false,
        status: 400,
        type: 'bad_request',
        message: 'the instance or share is required',
      };
    }
    const ciphertext =
      connector === 'mirth'
        ? await readMirthCiphertext(this.db, id, subject)
        : connector === 'admanager'
          ? await readAdManagerCiphertext(this.db, id, subject)
          : await readShareCiphertext(this.db, id, subject);
    if (!ciphertext.ok) return { ok: false, status: 500, type: 'store' };
    if (ciphertext.val === null) return { ok: false, status: 403, type: 'not_connected' };
    const opened = await this.open(subject, ciphertext.val);
    if (!opened.ok) return opened;
    const credentials =
      connector === 'mirth'
        ? parseMirthCredentials(opened.value)
        : connector === 'admanager'
          ? parseAdManagerCredentials(opened.value)
          : parseShareCredentials(opened.value);
    if (!credentials) return { ok: false, status: 503, type: 'bad_credentials' };
    body.credentials = credentials;
    return { ok: true };
  }

  /** The person's sealed value opened and parsed as JSON; locked and unreadable keys told apart. */
  private async open(
    subject: string,
    ciphertext: string
  ): Promise<
    { ok: true; value: unknown } | { ok: false; status: number; type: string; message?: string }
  > {
    const opened = await openForSubject(this.db, subject, ciphertext);
    if (!opened.ok) {
      if (
        opened.err.type === 'NEEDS_DELEGATION' ||
        opened.err.type === 'NEEDS_SESSION' ||
        opened.err.type === 'NOT_ENROLLED'
      ) {
        return {
          ok: false,
          status: 423,
          type: opened.err.type,
          message: 'Your key is not available to Renkei right now; sign in again to continue.',
        };
      }
      return { ok: false, status: 503, type: 'bad_credentials' };
    }
    try {
      return { ok: true, value: JSON.parse(opened.val) };
    } catch {
      return { ok: false, status: 503, type: 'bad_credentials' };
    }
  }

  private async forwardShareWrite(
    worker: { url: string; apiKey: string },
    url: URL,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const tenantId = url.searchParams.get('tenantId') ?? '';
    const shareId = url.searchParams.get('shareId') ?? '';
    const subject = url.searchParams.get('subject') ?? '';
    if (!shareId || !subject) return fail(response, 400, 'bad_request');
    const ciphertext = await readShareCiphertext(this.db, shareId, subject);
    if (!ciphertext.ok) return fail(response, 500, 'store');
    if (ciphertext.val === null) return fail(response, 403, 'not_connected');
    const opened = await this.open(subject, ciphertext.val);
    if (!opened.ok) return fail(response, opened.status, opened.type, opened.message);
    const credentials: ShareCredentials | null = parseShareCredentials(opened.value);
    if (!credentials) return fail(response, 503, 'bad_credentials');
    const bytes = await readBody(request, MAX_RAW_BYTES);
    if (bytes === null) return fail(response, 413, 'too_large');
    await this.send(worker, `write${url.search}`, response, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-fileshare-credentials': JSON.stringify(credentials),
      },
      body: new Uint8Array(bytes),
    });
  }

  private async forwardOnBasePutBytes(
    worker: { url: string; apiKey: string },
    url: URL,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const tenantId = url.searchParams.get('tenantId') ?? str(request.headers['x-onbase-tenant']);
    const subject = str(request.headers['x-onbase-subject']);
    const connectorName = str(request.headers['x-onbase-connector']) || 'onbase';
    if (!subject) {
      return fail(response, 400, 'bad_request', 'tenantId and x-onbase-subject are required');
    }
    const access = await this.grants.accessFor(connectorName, { subject });
    if (!access.ok) return fail(response, access.status, access.error);
    const bytes = await readBody(request, MAX_RAW_BYTES);
    if (bytes === null) return fail(response, 413, 'too_large');
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'x-onbase-token': access.token,
      'x-onbase-subject': subject,
    };
    for (const name of ['x-onbase-upload', 'x-onbase-connector']) {
      const value = str(request.headers[name]);
      if (value) headers[name] = value;
    }
    await this.send(worker, `put-bytes${url.search}`, response, {
      method: 'POST',
      headers,
      body: new Uint8Array(bytes),
    });
  }

  private async send(
    worker: { url: string; apiKey: string },
    opAndQuery: string,
    response: ServerResponse,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string | Uint8Array<ArrayBuffer>;
    }
  ): Promise<void> {
    let upstream: Response;
    try {
      upstream = await this.fetchImpl(`${worker.url}/v1/${opAndQuery}`, {
        method: init.method,
        headers: { ...init.headers, authorization: `Bearer ${worker.apiKey}` },
        body: init.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return fail(
        response,
        timedOut ? 504 : 502,
        timedOut ? 'timeout' : 'unreachable',
        `The connector worker ${timedOut ? 'timed out' : 'could not be reached'}.`
      );
    }
    await relay(upstream, response);
  }
}
