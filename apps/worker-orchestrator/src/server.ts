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
 *   POST /v1/ensure     `{ key, subject?, verify? }` → `{ sandboxId, url, key, headers }`:
 *                       the scope's sandbox, running — made, resumed or
 *                       waited for as needed — and the bearer key its
 *                       worker takes. Marks the scope active. `subject` is
 *                       whom the call is for: that sandbox's own data
 *                       store calls are scoped to the subjects named so.
 *   POST /v1/list       → `{ sandboxes: [...] }`: every sandbox that is
 *                       not deleted; a running one with its url and key.
 *   POST /v1/remove     `{ key }` → `{ removed }`: remove a scope's
 *                       sandbox now, with what it holds.
 *   POST /v1/expose     `{ key, port, emails }` → `{ url }`, or
 *                       `{ url: null }` where the provider has no such
 *                       door: open a port of the scope's sandbox to those
 *                       people's own browsers, signed in as themselves
 *                       (a code project's preview). `/v1/unexpose`
 *                       `{ key, port }` closes it.
 *   POST /v1/check      `{ settings?, secrets? }` → `{ ok, detail }`: try a
 *                       configuration — the one given (the Sandboxes
 *                       page, before it saves) or the one stored — by
 *                       asking its provider whether it answers. Makes no
 *                       sandbox.
 *   ANY  /unavailable/<why>/…   answers every request with a refusal in
 *                       the sandbox worker's error shape. Where the
 *                       client sends a call whose sandbox could not be
 *                       brought up (routing.ts says why it is done this
 *                       way): `starting` → 503 `sandbox_starting`,
 *                       anything else → 502 `sandbox_unavailable`.
 *
 * And, for the sandboxes themselves — each authenticated by its OWN key
 * (`authorization: Bearer <the sandbox's key>` with `x-sandbox-id`),
 * which opens nothing above:
 *
 *   POST /sandbox/v1/bootstrap  → `{ sealed }`: what the sandbox's worker
 *                       is started with (its secrets), sealed under that
 *                       sandbox's key. Never in its environment.
 *   POST /sandbox/v1/store      `{ domain, method, args }` → `{ ok, result }`:
 *                       one data store call, run here. A sandbox holds no
 *                       database connection; it may make the calls of
 *                       the sandbox's own repositories, each held to
 *                       the subjects that sandbox serves
 *                       (@renkei/db store/remote.ts).
 *
 * Bearer-authenticated (SANDBOX_ORCHESTRATOR_API_KEY). The answer to
 * `ensure` carries a sandbox's key, so this surface is for the processes
 * that already held the one shared sandbox key — the web app and the
 * queue worker — and nothing else.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  SANDBOX_STORE_POLICY,
  StoreCallRefused,
  decodeWire,
  dispatchStoreCall,
  encodeWire,
  type DataStore,
  type SandboxState,
  type SandboxStore,
} from '@renkei/db';
import { isRecord } from '@renkei/guards';
import {
  Orchestrator,
  OrchestratorError,
  type OrchestratorErrorType,
} from '@renkei/sandbox-orchestrator';
import { matchApiKey, readBody, sendJson } from '@renkei/worker-kit';
import { logger } from './logger';

const COMPONENT = 'worker-orchestrator/server';
const MAX_BODY_BYTES = 262_144;
/** A store call's arguments: rows of metadata, never file bytes. */
const MAX_STORE_BODY_BYTES = 4 * 1_048_576;
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
  /** The orchestrator in force; throws an OrchestratorError saying why when there is none. */
  orchestrator: () => Orchestrator;
  /** Which provider is in force, or why none is. */
  status: () => { provider: string | null; problem: string | null };
  store: () => SandboxStore;
  /** The whole data store, for the calls sandboxes make through this process. */
  dataStore: () => DataStore;
  /** Try a configuration: the one given, else the one stored. */
  check: (
    candidate: {
      settings: Record<string, unknown>;
      secrets: Record<string, string>;
    } | null
  ) => Promise<{ ok: boolean; detail: string }>;
}

export function createOrchestratorServer(deps: OrchestratorServerDeps): Server {
  /** A call from a sandbox's own worker: its id, and its own key as the bearer. */
  async function handleSandbox(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<void> {
    if (request.method !== 'POST') return sendError(response, 'method_not_allowed');
    const id = request.headers['x-sandbox-id'];
    const header = request.headers.authorization?.trim() ?? '';
    const key = header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7).trim() : '';
    // With no orchestrator in force there is no sandbox to be.
    if (deps.status().problem) return sendError(response, 'unauthorized');
    // Which sandbox is asking is settled before anything is read. Whatever
    // was presented goes to the one check that decides: the key must be the
    // one derived for that id, compared in constant time, and the sandbox
    // must exist (the orchestrator's `authenticate`). A missing id or key
    // is simply a pair that does not match.
    const sandbox = await deps.orchestrator().authenticate(typeof id === 'string' ? id : '', key);
    if (sandbox === null) return sendError(response, 'unauthorized');

    if (url.pathname === '/sandbox/v1/bootstrap') {
      request.resume();
      return sendJson(response, 200, {
        sealed: deps.orchestrator().sealedEnvironment(sandbox.id),
      });
    }
    if (url.pathname === '/sandbox/v1/store') {
      const raw = await readBody(request, MAX_STORE_BODY_BYTES);
      if (raw === null) return sendError(response, 'too_large');
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendError(response, 'bad_request');
      }
      if (
        !isRecord(body) ||
        typeof body.domain !== 'string' ||
        typeof body.method !== 'string' ||
        !Array.isArray(body.args)
      ) {
        return sendError(response, 'bad_request', 'domain, method and args are required');
      }
      const args = decodeWire(body.args);
      try {
        const result = await dispatchStoreCall(
          deps.dataStore(),
          SANDBOX_STORE_POLICY,
          { domain: body.domain, method: body.method, args: Array.isArray(args) ? args : [] },
          // Held to this sandbox's own scope: the subjects it serves.
          { kind: sandbox.kind, subjects: Orchestrator.servedBy(sandbox) }
        );
        return sendJson(response, 200, { ok: true, result: encodeWire(result) });
      } catch (error) {
        if (error instanceof StoreCallRefused) {
          logger.warn(
            'the sandbox for {scope} asked for {call}, which a sandbox may not; it was refused',
            {
              component: COMPONENT,
              sandbox: sandbox.id,
              scope: sandbox.routeKey,
              call: `${body.domain}.${body.method}`,
            }
          );
          return sendJson(response, 403, { ok: false, error: { message: error.message } });
        }
        // The call itself failed, as a query would: said back with the
        // code a caller may act on (a duplicate's SQLSTATE), no more.
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
        const constraint =
          isRecord(error) && typeof error.constraint === 'string' ? error.constraint : undefined;
        return sendJson(response, 200, {
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            ...(code ? { code } : {}),
            ...(constraint ? { constraint } : {}),
          },
        });
      }
    }
    return sendError(response, 'unknown_operation');
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://orchestrator.internal');
    if (request.method === 'GET' && url.pathname === '/health') {
      const status = deps.status();
      const health = status.problem ? null : deps.orchestrator().health();
      return sendJson(response, 200, {
        ok: true,
        orchestrator: true,
        provider: status.provider,
        ...(status.problem ? { problem: status.problem } : {}),
        ...(isRecord(health) && isRecord(health.capabilities)
          ? { capabilities: health.capabilities }
          : {}),
      });
    }
    if (url.pathname.startsWith('/sandbox/v1/')) return handleSandbox(request, response, url);
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

    if (url.pathname === '/v1/check') {
      const secrets: Record<string, string> = {};
      if (isRecord(body.secrets)) {
        for (const [name, value] of Object.entries(body.secrets)) {
          if (typeof value === 'string') secrets[name] = value;
        }
      }
      return sendJson(
        response,
        200,
        await deps.check(isRecord(body.settings) ? { settings: body.settings, secrets } : null)
      );
    }
    // Everything below needs an orchestrator; without one this throws the reason.
    const orchestrator = deps.orchestrator();
    if (url.pathname === '/v1/ensure') {
      if (typeof body.key !== 'string')
        return sendError(response, 'bad_request', 'key is required');
      const endpoint = await orchestrator.ensure(body.key, {
        verify: body.verify === true,
        // Whom the call is for; the sandbox's own store calls are scoped to those named here.
        subject: typeof body.subject === 'string' && body.subject ? body.subject : null,
      });
      return sendJson(response, 200, endpoint);
    }
    if (url.pathname === '/v1/remove') {
      if (typeof body.key !== 'string')
        return sendError(response, 'bad_request', 'key is required');
      const removed = await orchestrator.remove(body.key, 'removed on request');
      return sendJson(response, 200, { removed });
    }
    if (url.pathname === '/v1/expose' || url.pathname === '/v1/unexpose') {
      if (typeof body.key !== 'string' || typeof body.port !== 'number') {
        return sendError(response, 'bad_request', 'key and port are required');
      }
      if (url.pathname === '/v1/unexpose') {
        return sendJson(response, 200, {
          closed: await orchestrator.unexpose(body.key, body.port),
        });
      }
      const emails = Array.isArray(body.emails)
        ? body.emails.filter((email): email is string => typeof email === 'string')
        : [];
      const opened = await orchestrator.expose(body.key, body.port, emails);
      return sendJson(response, 200, { url: opened?.url ?? null });
    }
    if (url.pathname === '/v1/list') {
      const rows = await deps.store().list({ states: LISTED, limit: LIST_LIMIT });
      const sandboxes = [];
      for (const row of rows) {
        const endpoint = await orchestrator.endpointFor(row);
        sandboxes.push({
          id: row.id,
          routeKey: row.routeKey,
          kind: row.kind,
          provider: row.provider,
          state: row.state,
          createdAt: row.createdAt.toISOString(),
          lastActiveAt: row.lastActiveAt.toISOString(),
          ...(endpoint ? { url: endpoint.url, key: endpoint.key, headers: endpoint.headers } : {}),
        });
      }
      return sendJson(response, 200, { sandboxes });
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
