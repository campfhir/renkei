/**
 * The HTTP surface for code project previews — dispatched from server.ts:
 *
 *   POST /v1/previews/start  { subject, id, name, command, port?, token?, url, waitMs? }
 *   POST /v1/previews/list   { subject }
 *   POST /v1/previews/logs   { subject, name, lines? }
 *   POST /v1/previews/stop   { subject, name }
 *   ANY  /v1/previews/proxy/<name>/<path>     x-sandbox-subject: <subject>
 *   ANY  /v1/previews/public/<token>/<path>
 *
 * The JSON verbs keep the workspace rules: the caller's own checkout
 * first (`loadWorkspace` is workspace-endpoints' own gate), text out
 * scrubbed of the caller's environment values. The two proxy paths are
 * the one place this worker relays a request body and answer untouched:
 * they are reached only with the bearer key, by the web app, which has
 * already checked the person's session (or the share token's shape) and
 * names the subject in a header — the body is the request's own.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PREVIEW_LOGS_MAX_CHARS,
  clipOutput,
  isPreviewToken,
  previewLogLines,
  previewWaitMs,
  validateCommand,
  validatePreviewName,
  validatePreviewPort,
} from '@renkei/connector-sandbox';
import type { StoredWorkspace, WorkspaceTarget } from './workspace-store';
import { scrubEnv, type OpenedEnv } from './env-secrets';
import { homeDir, identityFor, workspaceDir } from './workspaces';
import { PreviewOpError, type PreviewManager, type StoredPreview } from './previews';
import { logErrorResponse } from './request-log';

export interface PreviewHandlerDeps {
  manager: PreviewManager;
  /** Whether this worker can run commands for a caller at all; off answers every verb 503. */
  capable: boolean;
  /** Whether the organization has code workspaces on, asked per request. */
  enabledFor: () => Promise<boolean>;
  /** The caller's ready checkout by `body.id`, or null with the refusal already sent. */
  loadWorkspace: (
    target: WorkspaceTarget,
    body: Record<string, unknown>,
    response: ServerResponse
  ) => Promise<StoredWorkspace | null>;
  /** The caller's environment secrets, opened for one request. */
  openEnv: (target: WorkspaceTarget) => Promise<OpenedEnv>;
  /** The running services' variables (SERVICE_<NAME>_HOST and friends); absent when services are off. */
  serviceEnv?: (target: WorkspaceTarget) => Promise<Record<string, string>>;
}

type Body = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
  logErrorResponse(status, type, message);
  sendJson(response, status, { error: { type, message } });
}

const STATUS_OF: Record<PreviewOpError['type'], number> = {
  not_found: 404,
  exists: 409,
  quota_exceeded: 429,
  bad_request: 400,
  port_in_use: 409,
  start_failed: 502,
};

export function previewWire(manager: PreviewManager, preview: StoredPreview, env?: OpenedEnv) {
  const scrub = (text: string) => (env ? scrubEnv(text, env) : text);
  return {
    id: preview.id,
    name: preview.name,
    workspaceId: preview.workspaceId,
    command: scrub(preview.command),
    port: preview.port,
    token: preview.token,
    url: preview.url,
    status: preview.status,
    exitCode: preview.exitCode,
    signal: preview.signal,
    startedAt: preview.startedAt.toISOString(),
    lastUsedAt: preview.lastUsedAt.toISOString(),
    expiresAt: manager.expiresAt(preview).toISOString(),
  };
}

export function createPreviewHandlers(deps: PreviewHandlerDeps) {
  const { manager } = deps;

  async function enabled(response: ServerResponse): Promise<boolean> {
    if (!deps.capable) {
      sendError(
        response,
        503,
        'workspaces_unavailable',
        'Code workspaces are not available on this deployment.'
      );
      return false;
    }
    if (!(await deps.enabledFor())) {
      sendError(
        response,
        503,
        'workspaces_unavailable',
        'Code workspaces are not enabled for this organization (admin → Settings → Sandbox).'
      );
      return false;
    }
    return true;
  }

  async function guarded(response: ServerResponse, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (error instanceof PreviewOpError) {
        return sendError(response, STATUS_OF[error.type], error.type, error.message);
      }
      throw error;
    }
  }

  async function handlePreviews(op: string, body: Body, response: ServerResponse): Promise<void> {
    const subject = str(body.subject);
    if (!subject) return sendError(response, 400, 'bad_request');
    if (!(await enabled(response))) return;
    const target: WorkspaceTarget = { subject };
    return guarded(response, async () => {
      switch (op) {
        case 'list': {
          const env = await deps.openEnv(target);
          return sendJson(response, 200, {
            previews: manager.list(target).map((preview) => previewWire(manager, preview, env)),
          });
        }
        case 'start': {
          const name = validatePreviewName(body.name);
          if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
          const command = validateCommand(body.command);
          if (!command.ok) return sendError(response, 400, 'bad_request', command.message);
          const port = validatePreviewPort(body.port);
          if (!port.ok) return sendError(response, 400, 'bad_request', port.message);
          const token = body.token === undefined || body.token === null ? null : body.token;
          if (token !== null && !isPreviewToken(token)) {
            return sendError(
              response,
              400,
              'bad_request',
              'A share token is 43 base64url characters.'
            );
          }
          const url = str(body.url).trim();
          if (!/^https?:\/\/\S+\/$/.test(url)) {
            return sendError(
              response,
              400,
              'bad_request',
              'url is where the web app serves the preview, ending in a slash.'
            );
          }
          const workspace = await deps.loadWorkspace(target, body, response);
          if (!workspace) return;
          const env = await deps.openEnv(target);
          const serviceEnv = deps.serviceEnv ? await deps.serviceEnv(target) : {};
          const started = await manager.start(target, {
            workspace: {
              id: workspace.id,
              cwd: workspaceDir(workspace.storageKey),
              home: homeDir(workspace.storageKey),
              identity: identityFor(workspace),
            },
            name: name.name,
            command: command.command,
            port: port.port,
            env: env.values,
            extraEnv: serviceEnv,
            token,
            url,
            waitMs: previewWaitMs(body.waitMs),
          });
          const logs = manager.logs(target, name.name, 40);
          return sendJson(response, started.listening ? 201 : 202, {
            preview: previewWire(manager, started.preview, env),
            listening: started.listening,
            logs: scrubEnv(
              logs.map((line) => `${line.at} [${line.stream}] ${line.line}`).join('\n'),
              env
            ),
          });
        }
        case 'logs': {
          const name = validatePreviewName(body.name);
          if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
          const env = await deps.openEnv(target);
          const preview = manager.get(target, name.name);
          const lines = manager.logs(target, name.name, previewLogLines(body.lines));
          const clipped = clipOutput(
            lines.map((line) => `${line.at} [${line.stream}] ${line.line}`).join('\n'),
            PREVIEW_LOGS_MAX_CHARS
          );
          return sendJson(response, 200, {
            preview: previewWire(manager, preview, env),
            logs: scrubEnv(clipped.text, env),
            truncated: clipped.clipped,
            count: lines.length,
          });
        }
        case 'stop': {
          const name = validatePreviewName(body.name);
          if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
          const env = await deps.openEnv(target);
          const stopped = await manager.stop(target, name.name);
          return sendJson(response, 200, { preview: previewWire(manager, stopped, env) });
        }
        default:
          return sendError(response, 404, 'unknown_operation');
      }
    });
  }

  /**
   * `/v1/previews/proxy/<name>/…` for the web app's session-checked
   * route (the subject in `x-sandbox-subject`), `/v1/previews/public/<token>/…`
   * for its share-link route. What follows the name or token, query
   * string included, is the path the preview's server gets.
   */
  async function handleProxy(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<void> {
    if (!(await enabled(response))) return;
    const publicPrefix = '/v1/previews/public/';
    const proxyPrefix = '/v1/previews/proxy/';
    let preview: StoredPreview | null = null;
    let rest = '';
    if (url.pathname.startsWith(publicPrefix)) {
      const [token, ...parts] = url.pathname.slice(publicPrefix.length).split('/');
      if (!isPreviewToken(token)) return sendError(response, 404, 'not_found', 'No such preview.');
      preview = manager.byToken(token);
      rest = parts.join('/');
    } else if (url.pathname.startsWith(proxyPrefix)) {
      const subject = str(request.headers['x-sandbox-subject']);
      const [rawName, ...parts] = url.pathname.slice(proxyPrefix.length).split('/');
      const name = validatePreviewName(rawName);
      if (!subject || !name.ok) return sendError(response, 404, 'not_found', 'No such preview.');
      preview = manager.reachable({ subject }, name.name);
      rest = parts.join('/');
    }
    if (!preview) {
      return sendError(
        response,
        404,
        'not_found',
        'No such preview is running — it was stopped, expired, or the sandbox worker restarted.'
      );
    }
    manager.proxy(preview, request, response, `/${rest}${url.search}`);
  }

  return { handlePreviews, handleProxy };
}
