/**
 * The orchestrator's HTTP surface: what the sandbox client
 * (packages/sandbox-client routing.ts) asks before every call it makes
 * for a scope.
 *
 *   GET  /health        open. `{ ok, orchestrator: true, provider,
 *                       capabilities? }` — the capabilities are what the
 *                       last sandbox to come up said it can do, in the
 *                       shape the sandbox worker's own /health has, so
 *                       the client's feature check reads either alike.
 *   POST /v1/ensure     `{ key, verify? }` → `{ sandboxId, url, key }`:
 *                       the scope's sandbox, running — made, resumed or
 *                       waited for as needed — and the bearer key its
 *                       worker takes. Marks the scope active.
 *   POST /v1/list       → `{ sandboxes: [...] }`: every sandbox that is
 *                       not deleted; a running one with its url and key.
 *   POST /v1/remove     `{ key }` → `{ removed }`: remove a scope's
 *                       sandbox now, with what it holds.
 *   ANY  /unavailable/<why>/…   answers every request with a refusal in
 *                       the sandbox worker's error shape. Where the
 *                       client sends a call whose sandbox could not be
 *                       brought up (routing.ts says why it is done this
 *                       way): `starting` → 503 `sandbox_starting`,
 *                       anything else → 502 `sandbox_unavailable`.
 *
 * Bearer-authenticated (SANDBOX_ORCHESTRATOR_API_KEY). The answer to
 * `ensure` carries a sandbox's key, so this surface is for the processes
 * that already held the one shared sandbox key — the web app and the
 * queue worker — and nothing else.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SandboxState, SandboxStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import {
  OrchestratorError,
  sandboxApiKey,
  type Orchestrator,
  type OrchestratorErrorType,
} from '@renkei/sandbox-orchestrator';
import { matchApiKey, readBody, sendJson } from '@renkei/worker-kit';
import { logger } from './logger';

const COMPONENT = 'worker-orchestrator/server';
const MAX_BODY_BYTES = 16_384;
const LIST_LIMIT = 1_000;
const LISTED: SandboxState[] = [
  'provisioning',
  'running',
  'suspending',
  'suspended',
  'resuming',
  'deleting',
];

type ErrorType =
  | OrchestratorErrorType
  | 'unauthorized'
  | 'method_not_allowed'
  | 'unknown_operation'
  | 'too_large'
  | 'internal';

const STATUS: Record<ErrorType, number> = {
  bad_request: 400,
  unauthorized: 401,
  unknown_operation: 404,
  method_not_allowed: 405,
  too_large: 413,
  internal: 500,
  provider: 502,
  // Not an outage: the sandbox is coming up, and the same call a moment later is served.
  starting: 503,
};

function sendError(response: ServerResponse, type: ErrorType, message?: string): void {
  sendJson(response, STATUS[type], { error: { type, ...(message ? { message } : {}) } });
}

export interface OrchestratorServerDeps {
  apiKeys: readonly string[];
  orchestrator: Orchestrator;
  store: () => SandboxStore;
  /** The deployment's sandbox key, for the keys `list` answers. */
  masterKey: string;
  providerName: string;
}

export function createOrchestratorServer(deps: OrchestratorServerDeps): Server {
  const { orchestrator } = deps;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://orchestrator.internal');
    if (request.method === 'GET' && url.pathname === '/health') {
      const health = orchestrator.health();
      return sendJson(response, 200, {
        ok: true,
        orchestrator: true,
        provider: deps.providerName,
        ...(isRecord(health) && isRecord(health.capabilities)
          ? { capabilities: health.capabilities }
          : {}),
      });
    }
    if (!matchApiKey(request, deps.apiKeys)) return sendError(response, 'unauthorized');
    if (url.pathname.startsWith('/unavailable/')) {
      request.resume();
      const starting = url.pathname.startsWith('/unavailable/starting/');
      return sendJson(response, starting ? 503 : 502, {
        error: starting
          ? {
              type: 'sandbox_starting',
              message: 'The sandbox is still starting. Try again in a moment.',
            }
          : {
              type: 'sandbox_unavailable',
              message: 'The sandbox could not be started. Try again in a moment.',
            },
      });
    }
    if (request.method !== 'POST') return sendError(response, 'method_not_allowed');
    const raw = await readBody(request, MAX_BODY_BYTES);
    if (raw === null) return sendError(response, 'too_large');
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return sendError(response, 'bad_request');
    }
    if (!isRecord(body)) return sendError(response, 'bad_request');

    if (url.pathname === '/v1/ensure') {
      if (typeof body.key !== 'string')
        return sendError(response, 'bad_request', 'key is required');
      const endpoint = await orchestrator.ensure(body.key, { verify: body.verify === true });
      return sendJson(response, 200, endpoint);
    }
    if (url.pathname === '/v1/remove') {
      if (typeof body.key !== 'string')
        return sendError(response, 'bad_request', 'key is required');
      const removed = await orchestrator.remove(body.key, 'removed on request');
      return sendJson(response, 200, { removed });
    }
    if (url.pathname === '/v1/list') {
      const rows = await deps.store().list({ states: LISTED, limit: LIST_LIMIT });
      return sendJson(response, 200, {
        sandboxes: rows.map((row) => ({
          id: row.id,
          routeKey: row.routeKey,
          kind: row.kind,
          provider: row.provider,
          state: row.state,
          createdAt: row.createdAt.toISOString(),
          lastActiveAt: row.lastActiveAt.toISOString(),
          ...(row.state === 'running' && row.address
            ? { url: row.address, key: sandboxApiKey(deps.masterKey, row.id) }
            : {}),
        })),
      });
    }
    return sendError(response, 'unknown_operation');
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof OrchestratorError) {
        // Said where it happened (the orchestrator logs a failed make or resume itself).
        if (!response.headersSent) sendError(response, error.type, error.message);
        else response.end();
        return;
      }
      logger.error(
        'a request to the orchestrator failed unexpectedly: {error}; it was not served',
        {
          component: COMPONENT,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        }
      );
      if (!response.headersSent) sendError(response, 'internal');
      else response.end();
    });
  });
  // As every worker's server: the caller closes idle sockets, never this side.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}
