/**
 * The sandbox worker's HTTP surface — how the web app reaches the agent
 * scratch space without a request handler ever touching the scratch disk
 * itself. Plain node:http, the worker-fileshares shape: a handful of POST
 * endpoints plus a health check, no framework.
 *
 * Two rules shape everything here, same as worker-fileshares:
 *
 *  - The bearer key is the trust boundary. Callers holding
 *    SANDBOX_WORKER_API_KEY are the web app, which has already
 *    authenticated its caller (`subject`) — every operation is scoped to
 *    that person's own staged files. No key configured means no service —
 *    fail closed, never open.
 *  - File bytes travel as raw request/response bodies (read answers
 *    octet-stream, write and fetch accept/produce it), never as
 *    JSON-wrapped base64.
 *
 * `/v1/fetch` and the `/v1/browser/*` verbs are the endpoints that reach
 * outside this process: fetch pulls a caller-supplied URL itself (through
 * @renkei/connector-sandbox's SSRF guard) so the model never has to see or
 * generate the bytes, and the browser verbs drive this worker's own
 * headless Chromium (browser.ts — behind an egress proxy that applies the
 * same guard to every connection). Every write path — fetch, write, and a
 * browser screenshot alike — enforces the per-file cap AND the per-caller
 * quota, and aborts mid-stream rather than buffering an oversized source in
 * full.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import {
  assertPublicHttpsUrl,
  BlockedUrlError,
  DEFAULT_FILE_TTL_MS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SUBJECT_QUOTA_BYTES,
  MAX_FILES_PER_SUBJECT,
  DEFAULT_BATCH_FILE_TTL_MS,
  DEFAULT_BATCH_MAX_FILE_BYTES,
  DEFAULT_BATCH_QUOTA_BYTES,
  MAX_FILES_PER_BATCH,
  validateFilename,
  type SandboxFileSummary,
} from '@renkei/connector-sandbox';
import {
  snapshotCharsOf,
  type BrowserPageState,
  type BrowserRunResult,
} from '@renkei/connector-sandbox';
import * as disk from './disk';
import * as store from './store';
import { BrowserOpError, type BrowserErrorType, type BrowserTarget } from './browser';
import { logger } from './logger';

/**
 * The browser verbs the HTTP surface dispatches to — structurally the
 * BrowserSessions class, named as an interface so the server can be
 * exercised against a scripted double without launching anything.
 */
export interface BrowserVerbs {
  sessionCount(): number;
  navigate(target: BrowserTarget, url: string, maxChars: number): Promise<BrowserPageState>;
  snapshot(target: BrowserTarget, maxChars: number): Promise<BrowserPageState>;
  click(target: BrowserTarget, ref: unknown, maxChars: number): Promise<BrowserPageState>;
  type(
    target: BrowserTarget,
    ref: unknown,
    text: unknown,
    submit: boolean,
    maxChars: number
  ): Promise<BrowserPageState>;
  select(target: BrowserTarget, ref: unknown, values: unknown, maxChars: number): Promise<BrowserPageState>;
  press(target: BrowserTarget, key: unknown, maxChars: number): Promise<BrowserPageState>;
  scroll(target: BrowserTarget, input: unknown, maxChars: number): Promise<BrowserPageState>;
  back(target: BrowserTarget, maxChars: number): Promise<BrowserPageState>;
  run(target: BrowserTarget, steps: unknown, maxChars: number): Promise<BrowserRunResult>;
  screenshot(target: BrowserTarget, fullPage: boolean): Promise<{ bytes: Buffer; url: string; title: string }>;
  close(target: BrowserTarget): Promise<boolean>;
}

export interface SandboxServerDeps {
  db: Kysely<DB>;
  /** Accepted bearer keys; empty means every request is refused. */
  apiKeys: string[];
  /** The per-tenant per-file ceiling (the org's attachment limit). */
  maxFileBytes?: (tenantId: string) => Promise<number>;
  /** The browser, when SANDBOX_BROWSER_ENABLED; null/absent answers every browser verb 503. */
  browser?: BrowserVerbs | null;
}

const MAX_JSON_BYTES = 1_048_576;
const FETCH_TIMEOUT_MS = 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH = 100;
const SOURCE_PATTERN = /^[a-zA-Z0-9:_.-]{1,255}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A batchId string from the wire, or null when absent/malformed. */
function batchIdOf(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

export async function orgMaxFileBytes(tenantId: string): Promise<number> {
  const settings = await getOrgSettings(tenantId);
  return settings.ok ? settings.val.maxAttachmentBytes : DEFAULT_MAX_FILE_BYTES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function authorized(request: IncomingMessage, keys: string[]): boolean {
  if (keys.length === 0) return false;
  const match = request.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1].trim();
  return keys.some((key) => {
    const bufA = Buffer.from(presented);
    const bufB = Buffer.from(key);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  });
}

function readBody(request: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    request.on('data', (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > cap) {
        request.removeAllListeners('data');
        request.removeAllListeners('end');
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, type: string, message?: string): void {
  sendJson(response, status, { error: { type, message } });
}

function summaryWire(summary: SandboxFileSummary) {
  return {
    id: summary.id,
    filename: summary.filename,
    contentType: summary.contentType,
    sizeBytes: summary.sizeBytes,
    source: summary.source,
    batchId: summary.batchId,
    createdAt: summary.createdAt.toISOString(),
    expiresAt: summary.expiresAt.toISOString(),
  };
}

function targetOf(body: Record<string, unknown>): store.SandboxTarget | null {
  const tenantId = str(body.tenantId);
  const subject = str(body.subject);
  if (!tenantId || !subject) return null;
  return { tenantId, subject };
}

const BROWSER_ERROR_STATUS: Record<BrowserErrorType, number> = {
  browser_unavailable: 503,
  blocked_url: 400,
  no_session: 409,
  bad_ref: 400,
  bad_request: 400,
  navigation_failed: 502,
  action_failed: 400,
};

function pageWire(state: BrowserPageState) {
  return { url: state.url, title: state.title, snapshot: state.snapshot, truncated: state.truncated };
}

/**
 * How much more this caller may stage right now, after their file-count
 * ceiling — 0 (or less) means "refuse outright," which the caller checks
 * before doing any I/O. A batchId switches to the SEPARATE, much larger
 * batch pool (packages/connector-sandbox/src/limits.ts) keyed by
 * (tenantId, batchId) instead of the interactive per-subject one, so a
 * document-ocr-pipeline batch never competes with the same person's
 * ordinary scratch space.
 */
async function quotaHeadroom(
  db: Kysely<DB>,
  target: store.SandboxTarget,
  batchId: string | null
): Promise<{ ok: true; remaining: number } | { ok: false; reason: 'too_many_files' }> {
  if (batchId) {
    const count = await store.countFilesForBatch(db, target.tenantId, batchId);
    if (count >= MAX_FILES_PER_BATCH) return { ok: false, reason: 'too_many_files' };
    const total = await store.totalStagedBytesForBatch(db, target.tenantId, batchId);
    return { ok: true, remaining: Math.max(0, DEFAULT_BATCH_QUOTA_BYTES - total) };
  }
  const count = await store.countFiles(db, target);
  if (count >= MAX_FILES_PER_SUBJECT) return { ok: false, reason: 'too_many_files' };
  const total = await store.totalStagedBytes(db, target);
  return { ok: true, remaining: Math.max(0, DEFAULT_SUBJECT_QUOTA_BYTES - total) };
}

function expiryFromNow(batchId: string | null): Date {
  const ttl = batchId ? DEFAULT_BATCH_FILE_TTL_MS : DEFAULT_FILE_TTL_MS;
  return new Date(Date.now() + ttl);
}

export function createSandboxServer(deps: SandboxServerDeps): Server {
  const maxFileBytes = deps.maxFileBytes ?? orgMaxFileBytes;

  async function handleFetch(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const target = targetOf(body);
    if (!target) return sendError(response, 400, 'bad_request');
    const named = validateFilename(str(body.filename));
    if (!named.ok) return sendError(response, 400, 'bad_filename');
    const batchId = batchIdOf(body.batchId);

    let url: URL;
    try {
      url = await assertPublicHttpsUrl(str(body.url));
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        return sendError(response, 400, 'blocked_url', error.message);
      }
      return sendError(response, 400, 'bad_request');
    }

    const headroom = await quotaHeadroom(deps.db, target, batchId);
    if (!headroom.ok) {
      return sendError(response, 429, 'quota_exceeded', 'Too many files staged — delete some first.');
    }
    if (headroom.remaining <= 0) {
      return sendError(response, 413, 'quota_exceeded', 'The scratch space quota is full.');
    }
    const cap = batchId
      ? Math.min(DEFAULT_BATCH_MAX_FILE_BYTES, headroom.remaining)
      : Math.min(await maxFileBytes(target.tenantId), DEFAULT_MAX_FILE_BYTES, headroom.remaining);

    let upstream: Response;
    try {
      upstream = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      return sendError(
        response,
        502,
        'fetch_failed',
        error instanceof Error ? error.message : 'Could not reach that URL.'
      );
    }
    if (!upstream.ok) {
      return sendError(response, 502, 'fetch_failed', `The URL answered HTTP ${upstream.status}.`);
    }
    const declared = Number(upstream.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap) {
      return sendError(response, 413, 'too_large', `The file exceeds the ${cap}-byte limit.`);
    }
    if (!upstream.body) {
      return sendError(response, 502, 'fetch_failed', 'The URL returned no content.');
    }

    const storageKey = disk.newStorageKey(target.tenantId, target.subject);
    // Response.body is a WHATWG web ReadableStream; Readable.fromWeb bridges
    // it to a Node Readable, which writeStream's AsyncIterable<Uint8Array>
    // parameter is built for.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const bodyStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    const written = await disk.writeStream(storageKey, bodyStream, cap);
    if (!written.ok) {
      return sendError(response, 413, 'too_large', `The file exceeds the ${cap}-byte limit.`);
    }

    const contentType = str(body.contentType) || upstream.headers.get('content-type') || null;
    const summary = await store.insertFile(deps.db, {
      ...target,
      filename: named.filename,
      contentType,
      sizeBytes: written.sizeBytes,
      storageKey,
      source: `fetch:${url.hostname}`,
      batchId,
      expiresAt: expiryFromNow(batchId),
    });
    sendJson(response, 200, summaryWire(summary));
  }

  async function handleWrite(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
    const tenantId = url.searchParams.get('tenantId') ?? '';
    const subject = url.searchParams.get('subject') ?? '';
    const named = validateFilename(url.searchParams.get('filename') ?? '');
    if (!tenantId || !subject || !named.ok) {
      return sendError(response, 400, 'bad_request');
    }
    const target = { tenantId, subject };
    const rawSource = url.searchParams.get('source') ?? '';
    const source = SOURCE_PATTERN.test(rawSource) ? rawSource : 'write';
    const batchId = batchIdOf(url.searchParams.get('batchId'));

    const headroom = await quotaHeadroom(deps.db, target, batchId);
    if (!headroom.ok) {
      return sendError(response, 429, 'quota_exceeded', 'Too many files staged — delete some first.');
    }
    if (headroom.remaining <= 0) {
      return sendError(response, 413, 'quota_exceeded', 'The scratch space quota is full.');
    }
    const cap = batchId
      ? Math.min(DEFAULT_BATCH_MAX_FILE_BYTES, headroom.remaining)
      : Math.min(await maxFileBytes(tenantId), DEFAULT_MAX_FILE_BYTES, headroom.remaining);

    const storageKey = disk.newStorageKey(tenantId, subject);
    const written = await disk.writeStream(storageKey, request, cap);
    if (!written.ok) {
      return sendError(response, 413, 'too_large', `The file exceeds the ${cap}-byte limit.`);
    }
    if (written.sizeBytes === 0) {
      await disk.deleteFile(storageKey);
      return sendError(response, 400, 'bad_request', 'The request body was empty.');
    }

    const summary = await store.insertFile(deps.db, {
      ...target,
      filename: named.filename,
      contentType: url.searchParams.get('contentType') || null,
      sizeBytes: written.sizeBytes,
      storageKey,
      source,
      batchId,
      expiresAt: expiryFromNow(batchId),
    });
    sendJson(response, 200, summaryWire(summary));
  }

  async function handleList(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const target = targetOf(body);
    if (!target) return sendError(response, 400, 'bad_request');
    const batchId = batchIdOf(body.batchId) ?? undefined;
    const files = await store.listFiles(deps.db, target, batchId);
    sendJson(response, 200, { files: files.map(summaryWire) });
  }

  async function handleStat(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const target = targetOf(body);
    if (!target) return sendError(response, 400, 'bad_request');
    const fileId = str(body.fileId);
    if (!fileId) return sendError(response, 400, 'bad_request');
    const file = await store.getFile(deps.db, target, fileId);
    if (!file) return sendError(response, 404, 'not_found');
    sendJson(response, 200, {
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
    });
  }

  async function handleRead(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const target = targetOf(body);
    if (!target) return sendError(response, 400, 'bad_request');
    const fileId = str(body.fileId);
    if (!fileId) return sendError(response, 400, 'bad_request');
    const file = await store.getFile(deps.db, target, fileId);
    if (!file) return sendError(response, 404, 'not_found');
    const bytes = await disk.readFile(file.storageKey);
    if (!bytes) return sendError(response, 404, 'not_found');
    response.writeHead(200, {
      'content-type': file.contentType || 'application/octet-stream',
      'content-length': bytes.byteLength,
      'x-sandbox-filename': encodeURIComponent(file.filename),
    });
    response.end(bytes);
  }

  async function handleDelete(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const target = targetOf(body);
    if (!target) return sendError(response, 400, 'bad_request');
    const fileId = str(body.fileId);
    if (!fileId) return sendError(response, 400, 'bad_request');
    const file = await store.deleteFile(deps.db, target, fileId);
    if (!file) return sendError(response, 404, 'not_found');
    await disk.deleteFile(file.storageKey);
    sendJson(response, 200, { deleted: true, id: file.id });
  }

  /**
   * Stage bytes this process is about to produce (a browser screenshot)
   * under the same quota, cap, and TTL as any fetched or written file. The
   * quota is checked BEFORE `produce` runs, so a full scratch space never
   * costs a screenshot nobody can keep. Answers the response itself on
   * refusal and returns null.
   */
  async function stageProduced(
    target: store.SandboxTarget,
    input: { filename: string; contentType: string | null },
    produce: () => Promise<{ bytes: Buffer; source: string }>,
    response: ServerResponse
  ): Promise<SandboxFileSummary | null> {
    const headroom = await quotaHeadroom(deps.db, target, null);
    if (!headroom.ok) {
      sendError(response, 429, 'quota_exceeded', 'Too many files staged — delete some first.');
      return null;
    }
    if (headroom.remaining <= 0) {
      sendError(response, 413, 'quota_exceeded', 'The scratch space quota is full.');
      return null;
    }
    const cap = Math.min(await maxFileBytes(target.tenantId), DEFAULT_MAX_FILE_BYTES, headroom.remaining);
    const produced = await produce();
    if (produced.bytes.byteLength > cap) {
      sendError(response, 413, 'too_large', `The file exceeds the ${cap}-byte limit.`);
      return null;
    }
    const storageKey = disk.newStorageKey(target.tenantId, target.subject);
    const written = await disk.writeStream(storageKey, Readable.from([produced.bytes]), cap);
    if (!written.ok) {
      sendError(response, 413, 'too_large', `The file exceeds the ${cap}-byte limit.`);
      return null;
    }
    return store.insertFile(deps.db, {
      ...target,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: written.sizeBytes,
      storageKey,
      source: produced.source,
      batchId: null,
      expiresAt: expiryFromNow(null),
    });
  }

  /**
   * The browser verbs: one JSON POST each, the caller's (tenantId, subject)
   * naming the session exactly as it names their staged files. Every verb
   * answers the page's new state; screenshot additionally stages a PNG,
   * and run answers how far a list of steps got plus the page it ended on.
   */
  async function handleBrowser(
    op: string,
    body: Record<string, unknown>,
    response: ServerResponse
  ): Promise<void> {
    const browser = deps.browser;
    if (op === 'status') {
      return sendJson(response, 200, {
        enabled: browser !== null && browser !== undefined,
        sessions: browser ? browser.sessionCount() : 0,
      });
    }
    if (!browser) {
      return sendError(
        response,
        503,
        'browser_unavailable',
        'The sandbox browser is not enabled on this deployment.'
      );
    }
    const target = targetOf(body);
    if (!target) return sendError(response, 400, 'bad_request');
    const maxChars = snapshotCharsOf(body.maxChars);
    try {
      switch (op) {
        case 'navigate':
          return sendJson(response, 200, pageWire(await browser.navigate(target, str(body.url), maxChars)));
        case 'snapshot':
          return sendJson(response, 200, pageWire(await browser.snapshot(target, maxChars)));
        case 'click':
          return sendJson(response, 200, pageWire(await browser.click(target, body.ref, maxChars)));
        case 'type':
          return sendJson(
            response,
            200,
            pageWire(await browser.type(target, body.ref, body.text, body.submit === true, maxChars))
          );
        case 'select':
          return sendJson(response, 200, pageWire(await browser.select(target, body.ref, body.values, maxChars)));
        case 'press':
          return sendJson(response, 200, pageWire(await browser.press(target, body.key, maxChars)));
        case 'scroll':
          return sendJson(
            response,
            200,
            pageWire(
              await browser.scroll(
                target,
                { ref: body.ref, direction: body.direction, amount: body.amount },
                maxChars
              )
            )
          );
        case 'back':
          return sendJson(response, 200, pageWire(await browser.back(target, maxChars)));
        case 'run': {
          const outcome = await browser.run(target, body.steps, maxChars);
          return sendJson(response, 200, {
            completed: outcome.completed,
            page: outcome.page ? pageWire(outcome.page) : null,
            failed: outcome.failed,
          });
        }
        case 'close':
          return sendJson(response, 200, { closed: await browser.close(target) });
        case 'screenshot': {
          const named = validateFilename(str(body.filename) || `screenshot-${Date.now()}.png`);
          if (!named.ok) return sendError(response, 400, 'bad_filename');
          let shot: { bytes: Buffer; url: string; title: string } | null = null;
          const staged = await stageProduced(
            target,
            { filename: named.filename, contentType: 'image/png' },
            async () => {
              shot = await browser.screenshot(target, body.fullPage === true);
              let host = 'page';
              try {
                host = new URL(shot.url).hostname || host;
              } catch {
                // about:blank and friends have no host worth naming.
              }
              return { bytes: shot.bytes, source: `browser:${host}` };
            },
            response
          );
          if (!staged || !shot) return;
          const taken: { url: string; title: string } = shot;
          return sendJson(response, 200, { file: summaryWire(staged), url: taken.url, title: taken.title });
        }
        default:
          return sendError(response, 404, 'unknown_operation');
      }
    } catch (error) {
      if (error instanceof BrowserOpError) {
        return sendError(response, BROWSER_ERROR_STATUS[error.type], error.type, error.message);
      }
      throw error;
    }
  }

  const jsonHandlers: Record<
    string,
    (body: Record<string, unknown>, response: ServerResponse) => Promise<void>
  > = {
    fetch: handleFetch,
    list: handleList,
    stat: handleStat,
    read: handleRead,
    delete: handleDelete,
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://sandbox.internal');

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { ok: true });
    }
    if (!authorized(request, deps.apiKeys)) {
      return sendError(response, 401, 'unauthorized');
    }
    if (request.method !== 'POST') {
      return sendError(response, 405, 'method_not_allowed');
    }

    // Write is the one endpoint whose body IS the file: metadata rides the
    // query string, matching the fileshare worker's /v1/write.
    if (url.pathname === '/v1/write') {
      return handleWrite(request, url, response);
    }

    const op = url.pathname.startsWith('/v1/') ? url.pathname.slice('/v1/'.length) : '';
    const browserOp = op.startsWith('browser/') ? op.slice('browser/'.length) : null;
    const jsonHandler = browserOp !== null ? null : jsonHandlers[op];
    if (browserOp === null && !jsonHandler) {
      return sendError(response, 404, 'unknown_operation');
    }
    const raw = await readBody(request, MAX_JSON_BYTES);
    if (raw === null) return sendError(response, 413, 'too_large');
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return sendError(response, 400, 'bad_request');
    }
    if (!isRecord(parsedBody)) return sendError(response, 400, 'bad_request');
    if (browserOp !== null) return handleBrowser(browserOp, parsedBody, response);
    await jsonHandler!(parsedBody, response);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error('unhandled sandbox op failure: {error}', {
        component: 'worker-sandbox/server',
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        sendError(response, 500, 'internal');
      } else {
        response.end();
      }
    });
  });

  // The TTL sweep: expired rows lose their bytes, then their row. Errors on
  // one file never stop the batch — a locked/already-gone file is logged and
  // skipped so the sweep keeps making progress.
  const sweep = setInterval(() => {
    void (async () => {
      const expired = await store.listExpired(deps.db, SWEEP_BATCH);
      for (const file of expired) {
        try {
          await disk.deleteFile(file.storageKey);
          await store.deleteById(deps.db, file.id);
        } catch (error) {
          logger.warn('sweep could not remove {id}: {error}', {
            component: 'worker-sandbox/sweep',
            id: file.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
  }, SWEEP_INTERVAL_MS);
  sweep.unref();
  server.on('close', () => clearInterval(sweep));

  return server;
}
