/**
 * The fileshare worker's HTTP surface — how the web app reaches SMB/SFTP
 * without ever opening a protocol session in a request handler.
 *
 * Plain node:http on purpose: a handful of POST endpoints and a health
 * check need no framework, and this process's whole point is to stay small
 * and isolated. Two rules shape everything here:
 *
 *  - The service layer (@renkei/connector-fileshares) is the authority.
 *    This file parses, dispatches, and serializes; credential resolution
 *    and byte caps run inside the service functions, and authorization
 *    itself belongs to the file server judging the caller's own account —
 *    so a bug here can produce a wrong status code but not a wrong
 *    permission.
 *  - The bearer key is the trust boundary. Callers holding
 *    FILESHARES_WORKER_API_KEY are the web app, which has already
 *    authenticated its user (`subject`) — every operation runs on that
 *    person's own stored credential, which only THIS process decrypts. No
 *    key configured means no service — fail closed, never open. Keys are
 *    comma-separated so a rotation can overlap, the LOG_SHIP_API_KEY
 *    convention.
 *
 * File bytes travel as raw request/response bodies (read answers
 * octet-stream, write accepts it), never as JSON-wrapped base64 — the same
 * rule the MCP upload flow keeps.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import {
  parseShareCredentials,
  serviceListFolder,
  serviceMakeFolder,
  serviceMoveEntry,
  servicePreviewRemove,
  serviceReadFile,
  serviceRemoveEntry,
  serviceRenameEntry,
  serviceStatEntry,
  serviceTestConnection,
  serviceWriteFile,
} from '@renkei/connector-fileshares';
import type { ServiceDeps, ServiceError, SubjectTarget } from '@renkei/connector-fileshares';
import { logger } from './logger';

export interface FileshareServerDeps {
  db: Kysely<DB>;
  /** The parsed TOKEN_ENCRYPTION_KEY. */
  encryptionKey: Buffer;
  /** Accepted bearer keys; empty means every request is refused. */
  apiKeys: string[];
  /**
   * The per-tenant transfer ceiling (the org's attachment limit). Injected
   * so tests need no settings store; production uses orgTransferLimit.
   */
  maxTransferBytes?: (tenantId: string) => Promise<number>;
}

const DEFAULT_TRANSFER_BYTES = 20_971_520;
/** Operation requests are small JSON; anything bigger is not one of ours. */
const MAX_JSON_BYTES = 1_048_576;

export async function orgTransferLimit(tenantId: string): Promise<number> {
  const settings = await getOrgSettings(tenantId);
  return settings.ok ? settings.val.maxAttachmentBytes : DEFAULT_TRANSFER_BYTES;
}

/** Map a service error tag onto the HTTP status this server answers. */
export function statusForServiceError(tag: ServiceError): number {
  switch (tag) {
    case 'no_share':
    case 'not_found':
      return 404;
    case 'access_denied':
    case 'not_connected':
      return 403;
    case 'bad_path':
      return 400;
    case 'too_large':
      return 413;
    case 'timeout':
      return 504;
    case 'exists':
    case 'not_empty':
      return 409;
    case 'bad_credentials':
      return 503;
    case 'store':
      return 500;
    default:
      return 502;
  }
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
    // Length is not secret (it leaks via the comparison anyway); the contents are.
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  });
}

/** Read a request body up to `cap` bytes; null means the cap was exceeded. */
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

function sendServiceError(
  response: ServerResponse,
  error: { type: ServiceError; message?: string }
): void {
  sendJson(response, statusForServiceError(error.type), {
    error: { type: error.type, message: error.message },
  });
}

function targetOf(body: Record<string, unknown>): SubjectTarget | null {
  const tenantId = str(body.tenantId);
  const shareId = str(body.shareId);
  const subject = str(body.subject);
  if (!tenantId || !shareId || !subject) return null;
  return { tenantId, shareId, subject };
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

type JsonHandler = (
  deps: ServiceDeps,
  body: Record<string, unknown>,
  response: ServerResponse
) => Promise<void>;

function makeJsonHandlers(transferLimit: (tenantId: string) => Promise<number>): Record<string, JsonHandler> {
  return {
    async list(deps, body, response) {
      const target = targetOf(body);
      if (!target) return sendJson(response, 400, { error: { type: 'bad_request' } });
      const listed = await serviceListFolder(deps, target, str(body.path) || '/');
      if (!listed.ok) return sendServiceError(response, listed.err);
      sendJson(response, 200, {
        share: listed.val.share,
        path: listed.val.path,
        entries: listed.val.entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          modifiedAt: iso(entry.modifiedAt),
        })),
      });
    },

    async stat(deps, body, response) {
      const target = targetOf(body);
      if (!target) return sendJson(response, 400, { error: { type: 'bad_request' } });
      const stats = await serviceStatEntry(deps, target, str(body.path));
      if (!stats.ok) return sendServiceError(response, stats.err);
      sendJson(response, 200, {
        share: stats.val.share,
        path: stats.val.path,
        kind: stats.val.kind,
        size: stats.val.size,
        modifiedAt: iso(stats.val.modifiedAt),
        createdAt: iso(stats.val.createdAt),
        owner: stats.val.owner,
        group: stats.val.group,
      });
    },

    async read(deps, body, response) {
      const target = targetOf(body);
      if (!target) return sendJson(response, 400, { error: { type: 'bad_request' } });
      const limit = await transferLimit(target.tenantId);
      const requested = typeof body.maxBytes === 'number' && body.maxBytes > 0 ? body.maxBytes : limit;
      const content = await serviceReadFile(
        deps,
        target,
        str(body.path),
        Math.min(requested, limit)
      );
      if (!content.ok) return sendServiceError(response, content.err);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': content.val.bytes.byteLength,
        'x-fileshare-name': encodeURIComponent(content.val.share.name),
      });
      response.end(Buffer.from(content.val.bytes));
    },

    async mkdir(deps, body, response) {
      const target = targetOf(body);
      if (!target) return sendJson(response, 400, { error: { type: 'bad_request' } });
      const made = await serviceMakeFolder(deps, target, str(body.path));
      if (!made.ok) return sendServiceError(response, made.err);
      sendJson(response, 200, { share: made.val.share, path: made.val.path });
    },

    async remove(deps, body, response) {
      const target = targetOf(body);
      if (!target) return sendJson(response, 400, { error: { type: 'bad_request' } });
      const removed = await serviceRemoveEntry(deps, target, str(body.path));
      if (!removed.ok) return sendServiceError(response, removed.err);
      sendJson(response, 200, { share: removed.val.share, path: removed.val.path });
    },

    async 'remove-preview'(deps, body, response) {
      const target = targetOf(body);
      if (!target) return sendJson(response, 400, { error: { type: 'bad_request' } });
      const preview = await servicePreviewRemove(deps, target, str(body.path));
      if (!preview.ok) return sendServiceError(response, preview.err);
      sendJson(response, 200, {
        share: preview.val.share,
        path: preview.val.path,
        kind: preview.val.kind,
        size: preview.val.size,
        modifiedAt: iso(preview.val.modifiedAt),
      });
    },

    async move(deps, body, response) {
      const target = targetOf(body);
      if (!target) return sendJson(response, 400, { error: { type: 'bad_request' } });
      const moved = await serviceMoveEntry(deps, target, str(body.path), str(body.toFolder) || '/');
      if (!moved.ok) return sendServiceError(response, moved.err);
      sendJson(response, 200, {
        share: moved.val.share,
        path: moved.val.path,
        unchanged: moved.val.unchanged,
      });
    },

    async rename(deps, body, response) {
      const target = targetOf(body);
      if (!target) return sendJson(response, 400, { error: { type: 'bad_request' } });
      const renamed = await serviceRenameEntry(deps, target, str(body.path), str(body.newName));
      if (!renamed.ok) return sendServiceError(response, renamed.err);
      sendJson(response, 200, {
        share: renamed.val.share,
        path: renamed.val.path,
        unchanged: renamed.val.unchanged,
      });
    },

    async 'test-connection'(deps, body, response) {
      // The connect flow's validation: a person's unsaved credential
      // crosses the authenticated seam once, is re-validated here at the
      // trust boundary, and is tried against the STORED share before the
      // web app seals and saves it.
      const tenantId = str(body.tenantId);
      const shareId = str(body.shareId);
      const credentials = parseShareCredentials(body.credentials);
      if (!tenantId || !shareId || !credentials) {
        return sendJson(response, 400, { error: { type: 'bad_request' } });
      }
      const tested = await serviceTestConnection(deps, tenantId, shareId, credentials);
      if (!tested.ok) return sendServiceError(response, tested.err);
      sendJson(response, 200, { entries: tested.val.entries });
    },
  };
}

export function createFileshareServer(deps: FileshareServerDeps): Server {
  const serviceDeps: ServiceDeps = { db: deps.db, encryptionKey: deps.encryptionKey };
  const transferLimit = deps.maxTransferBytes ?? orgTransferLimit;
  const jsonHandlers = makeJsonHandlers(transferLimit);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fileshares.internal');

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { ok: true });
    }
    if (!authorized(request, deps.apiKeys)) {
      return sendJson(response, 401, { error: { type: 'unauthorized' } });
    }
    if (request.method !== 'POST') {
      return sendJson(response, 405, { error: { type: 'method_not_allowed' } });
    }

    // Write is the one endpoint whose body IS the file: metadata rides the
    // query string so the payload needs no envelope (and no base64 tax).
    if (url.pathname === '/v1/write') {
      const target = {
        tenantId: url.searchParams.get('tenantId') ?? '',
        shareId: url.searchParams.get('shareId') ?? '',
        subject: url.searchParams.get('subject') ?? '',
      };
      const path = url.searchParams.get('path') ?? '';
      if (!target.tenantId || !target.shareId || !target.subject || !path) {
        return sendJson(response, 400, { error: { type: 'bad_request' } });
      }
      const limit = await transferLimit(target.tenantId);
      const body = await readBody(request, limit);
      if (body === null) {
        return sendJson(response, 413, {
          error: { type: 'too_large', message: `The file exceeds the ${limit}-byte limit.` },
        });
      }
      if (body.byteLength === 0) {
        return sendJson(response, 400, { error: { type: 'bad_request' } });
      }
      const written = await serviceWriteFile(
        serviceDeps,
        target,
        path,
        new Uint8Array(body),
        limit
      );
      if (!written.ok) return sendServiceError(response, written.err);
      return sendJson(response, 200, { share: written.val.share, path: written.val.path });
    }

    const op = url.pathname.startsWith('/v1/') ? url.pathname.slice('/v1/'.length) : '';
    const handler = jsonHandlers[op];
    if (!handler) {
      return sendJson(response, 404, { error: { type: 'unknown_operation' } });
    }
    const raw = await readBody(request, MAX_JSON_BYTES);
    if (raw === null) {
      return sendJson(response, 413, { error: { type: 'too_large' } });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return sendJson(response, 400, { error: { type: 'bad_request' } });
    }
    if (!isRecord(body)) {
      return sendJson(response, 400, { error: { type: 'bad_request' } });
    }
    await handler(serviceDeps, body, response);
  }

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error('unhandled fileshare op failure: {error}', {
        component: 'worker-fileshares/server',
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        sendJson(response, 500, { error: { type: 'internal' } });
      } else {
        response.end();
      }
    });
  });
}
