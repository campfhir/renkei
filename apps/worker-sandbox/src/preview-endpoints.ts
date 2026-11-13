/**
 * The HTTP surface for code project previews — dispatched from server.ts:
 *
 *   POST /v1/previews/start  { subject, id, name, command, ports: [{name, token?, url}], waitMs? }
 *   POST /v1/previews/list   { subject }
 *   POST /v1/previews/logs   { subject, name, lines? }
 *   POST /v1/previews/stop   { subject, name }
 *   ANY  /v1/previews/proxy/<name>/<path>              x-sandbox-subject: <subject>   (the first port)
 *   ANY  /v1/previews/port/<name>/<port name>/<path>   x-sandbox-subject: <subject>   (a named port)
 *   ANY  /v1/previews/public/<token>/<path>                                           (a port's share token)
 *
 * The JSON verbs keep the workspace rules: the caller's own checkout
 * first (`loadWorkspace` is workspace-endpoints' own gate), text out
 * scrubbed of the caller's environment values. The proxy paths are the
 * one place this worker relays a request body and answer untouched:
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
  validatePreviewPortName,
  validatePreviewPorts,
  type PreviewPortBinding,
} from '@renkei/connector-sandbox';
import { isRecord } from '@renkei/guards';
import type { StoredWorkspace, WorkspaceTarget } from './workspace-store';
import { scrubEnv, type OpenedEnv } from './env-secrets';
import { homeDir, identityFor, workspaceDir } from './workspaces';
import {
  PreviewOpError,
  type PreviewManager,
  type PreviewPortRequest,
  type StoredPreview,
} from './previews';
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

const URL_PATTERN = /^https?:\/\/\S+\/$/;

export function previewWire(manager: PreviewManager, preview: StoredPreview, env?: OpenedEnv) {
  const scrub = (text: string) => (env ? scrubEnv(text, env) : text);
  const [primary] = preview.ports;
  return {
    id: preview.id,
    name: preview.name,
    workspaceId: preview.workspaceId,
    command: scrub(preview.command),
    ports: preview.ports.map((binding: PreviewPortBinding) => ({ ...binding })),
    // The first port's, for a reader that wants one number and one address.
    port: primary?.port ?? 0,
    token: primary?.token ?? null,
    url: primary?.url ?? '',
    status: preview.status,
    exitCode: preview.exitCode,
    signal: preview.signal,
    startedAt: preview.startedAt.toISOString(),
    lastUsedAt: preview.lastUsedAt.toISOString(),
    expiresAt: manager.expiresAt(preview).toISOString(),
  };
}

/**
 * The ports a start asks for: `[{name, token?, url}]`, names validated as
 * a set, each with where the web app serves it and its share token when
 * public. Null with the refusal when any of it is off.
 */
function portsOf(body: Body, response: ServerResponse): PreviewPortRequest[] | null {
  const raw = Array.isArray(body.ports) ? body.ports : undefined;
  const names = validatePreviewPorts(raw?.map((entry) => (isRecord(entry) ? entry.name : entry)));
  if (!names.ok) {
    sendError(response, 400, 'bad_request', names.message);
    return null;
  }
  const requests: PreviewPortRequest[] = [];
  for (let index = 0; index < names.ports.length; index += 1) {
    const entry = raw?.[index];
    const record = isRecord(entry) ? entry : {};
    const token = record.token === undefined || record.token === null ? null : record.token;
    if (token !== null && !isPreviewToken(token)) {
      sendError(response, 400, 'bad_request', 'A share token is 43 base64url characters.');
      return null;
    }
    const url = str(record.url).trim();
    if (!URL_PATTERN.test(url)) {
      sendError(
        response,
        400,
        'bad_request',
        `Port ${names.ports[index]} needs url: where the web app serves it, ending in a slash.`
      );
      return null;
    }
    requests.push({ name: names.ports[index]!, token, url });
  }
  return requests;
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

  const renderLogs = (lines: ReturnType<PreviewManager['logs']>) =>
    lines.map((line) => `${line.at} [${line.stream}] ${line.line}`).join('\n');

  async function handlePreviews(op: string, body: Body, response: ServerResponse): Promise<void> {
    if (op === 'holds-token') {
      // A share link names no caller, so the app cannot tell which instance
      // serves it: it asks each whether the token is one of theirs.
      if (!(await enabled(response))) return;
      const token = str(body.token);
      return sendJson(response, 200, {
        held: isPreviewToken(token) && manager.byToken(token) !== null,
      });
    }
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
            portRange: manager.range,
          });
        }
        case 'start': {
          const name = validatePreviewName(body.name);
          if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
          const command = validateCommand(body.command);
          if (!command.ok) return sendError(response, 400, 'bad_request', command.message);
          const ports = portsOf(body, response);
          if (!ports) return;
          const workspace = await deps.loadWorkspace(target, body, response);
          if (!workspace) return;
          const env = await deps.openEnv(target);
          const serviceEnv = deps.serviceEnv ? await deps.serviceEnv(target) : {};
          // The other previews' ports and addresses, so a UI finds its API.
          const neighbours = manager.environmentFor(target, name.name);
          const started = await manager.start(target, {
            workspace: {
              id: workspace.id,
              cwd: workspaceDir(workspace.storageKey),
              home: homeDir(workspace.storageKey),
              identity: identityFor(workspace),
            },
            name: name.name,
            command: command.command,
            ports,
            env: env.values,
            extraEnv: { ...serviceEnv, ...neighbours },
            waitMs: previewWaitMs(body.waitMs),
          });
          const logs = manager.logs(target, name.name, 40);
          return sendJson(response, started.listening.length ? 201 : 202, {
            preview: previewWire(manager, started.preview, env),
            listening: started.listening,
            logs: scrubEnv(renderLogs(logs), env),
          });
        }
        case 'logs': {
          const name = validatePreviewName(body.name);
          if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
          const env = await deps.openEnv(target);
          const preview = manager.get(target, name.name);
          const lines = manager.logs(target, name.name, previewLogLines(body.lines));
          const clipped = clipOutput(renderLogs(lines), PREVIEW_LOGS_MAX_CHARS);
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
   * `/v1/previews/proxy/<name>/…` for the first port and
   * `/v1/previews/port/<name>/<port name>/…` for a named one, both for
   * the web app's session-checked routes (the subject in
   * `x-sandbox-subject`); `/v1/previews/public/<token>/…` for its share-
   * link route, a token naming one port. What follows, query string
   * included, is the path the preview's server gets.
   */
  async function handleProxy(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<void> {
    if (!(await enabled(response))) return;
    const publicPrefix = '/v1/previews/public/';
    const proxyPrefix = '/v1/previews/proxy/';
    const portPrefix = '/v1/previews/port/';
    let found: { preview: StoredPreview; port: PreviewPortBinding } | null = null;
    let rest = '';
    if (url.pathname.startsWith(publicPrefix)) {
      const [token, ...parts] = url.pathname.slice(publicPrefix.length).split('/');
      if (!isPreviewToken(token)) return sendError(response, 404, 'not_found', 'No such preview.');
      found = manager.byToken(token);
      rest = parts.join('/');
    } else if (url.pathname.startsWith(proxyPrefix) || url.pathname.startsWith(portPrefix)) {
      const named = url.pathname.startsWith(portPrefix);
      const subject = str(request.headers['x-sandbox-subject']);
      const [rawName, ...parts] = url.pathname
        .slice((named ? portPrefix : proxyPrefix).length)
        .split('/');
      const name = validatePreviewName(rawName);
      if (!subject || !name.ok) return sendError(response, 404, 'not_found', 'No such preview.');
      let portName: string | null = null;
      if (named) {
        const port = validatePreviewPortName(parts.shift());
        if (!port.ok) return sendError(response, 404, 'not_found', 'No such preview port.');
        portName = port.name;
      }
      found = manager.reachable({ subject }, name.name, portName);
      rest = parts.join('/');
    }
    if (!found) {
      return sendError(
        response,
        404,
        'not_found',
        'No such preview is running — it was stopped, expired, or the sandbox worker restarted.'
      );
    }
    manager.proxy(found.preview, found.port.port, request, response, `/${rest}${url.search}`);
  }

  return { handlePreviews, handleProxy };
}
