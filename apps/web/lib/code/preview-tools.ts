/**
 * The code_preview_* tools: the project's own server started in the
 * chat's worktree and served by this app, so the person can open what
 * the chat built. The worker runs the process and relays requests
 * (apps/worker-sandbox/src/previews.ts); this app's routes check the
 * session or the share token (lib/code/previews.ts). The address the
 * model answers with is built here from the deployment's origin, the
 * project, the chat and the name — and, for a public preview, from the
 * share token minted here.
 */

import {
  PREVIEW_LOG_MAX_LINES,
  PREVIEW_MAX_PER_SUBJECT,
  PREVIEW_PORT_MAX,
  PREVIEW_PORT_MIN,
  PREVIEW_PORTS_MAX,
  PREVIEW_START_WAIT_MAX_MS,
  validatePreviewPorts,
} from '@renkei/connector-sandbox';
import {
  sbPreviewList,
  sbPreviewLogs,
  sbPreviewStart,
  sbPreviewStop,
  type SandboxClientError,
  type SandboxTarget,
  type WirePreview,
} from '@renkei/sandbox-client';
import { errorResult, textResult, type LocalTool } from '@/lib/chat/local-tools';
import type { McpToolResult } from '@renkei/mcp-client';
import {
  mintPreviewToken,
  previewAddresses,
  previewPortRequests,
  type PreviewAddresses,
} from './previews';

export interface PreviewToolDeps {
  target: SandboxTarget;
  ref: { id: string };
  /** The deployment's origin, which the addresses hang off. */
  origin: string;
  /** The organization's preview host, when previews are served on one (preview-host.ts). */
  previewHost?: string;
  failed: (error: SandboxClientError) => McpToolResult;
}

/** How long the turn waits on a start: the worker's longest wait, plus the client's margin. */
export const PREVIEW_START_TOOL_TIMEOUT_MS = PREVIEW_START_WAIT_MAX_MS + 60_000;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** One preview as the model reads it: name, state, each port's number and address — never a token on its own. */
export function renderPreview(preview: WirePreview, addresses: PreviewAddresses): string {
  const state =
    preview.status === 'exited'
      ? `exited${preview.exitCode !== null ? ` (code ${preview.exitCode})` : ''}${preview.signal ? ` (${preview.signal})` : ''}`
      : preview.status;
  const ports = preview.ports.map((port) => `${port.name}=${port.port}`).join(', ');
  if (preview.status === 'exited')
    return `${preview.name}: ${state}, ports ${ports}, \`${preview.command}\``;
  const lines = addresses.ports.map(
    (port, index) =>
      `  ${port.name} (port ${preview.ports[index]?.port ?? '?'}${index === 0 ? ', PORT' : ''}): open ${port.url}` +
      (port.publicUrl ? `\n    share link (no sign-in): ${port.publicUrl}` : '')
  );
  return (
    `${preview.name}: ${state}, \`${preview.command}\`\n${lines.join('\n')}` +
    `\n  until ${preview.expiresAt} unless requested again`
  );
}

export function previewTools(deps: PreviewToolDeps): LocalTool[] {
  const { target, ref, failed } = deps;
  const addressesOf = (
    context: { projectId: string | null; chatId: string },
    preview: { name: string; ports: ReadonlyArray<{ name: string; token: string | null }> }
  ) =>
    previewAddresses(
      deps.origin,
      {
        projectId: context.projectId ?? '',
        chatId: context.chatId,
        name: preview.name,
        ports: preview.ports,
      },
      deps.previewHost ?? ''
    );

  return [
    {
      def: {
        name: 'code_previews',
        description:
          'The previews running for this project — servers started with code_preview_start — ' +
          'with their state, port and the address to open. Nothing running answers so.',
        inputSchema: { type: 'object', properties: {} },
      },
      readOnly: true,
      async execute(_input, context) {
        const listed = await sbPreviewList(target);
        if (!listed.ok) return failed(listed.err);
        if (listed.val.length === 0) {
          return textResult(
            'No previews are running for this project. code_preview_start runs the project’s own server and answers the address to open.'
          );
        }
        return textResult(
          listed.val
            .map((preview) => renderPreview(preview, addressesOf(context, preview)))
            .join('\n')
        );
      },
    },
    {
      def: {
        name: 'code_preview_start',
        description:
          'Start the project’s own server in this checkout so the person can open it in a ' +
          'browser: the command (pnpm dev, npm start, python -m http.server, uvicorn app:app …) ' +
          'runs with the project’s environment and PORT set to the port it must listen on — bind ' +
          `0.0.0.0 (or the given PORT and HOST). Ports are the sandbox's own pool (${PREVIEW_PORT_MIN}-${PREVIEW_PORT_MAX}), ` +
          'never a port of your choosing: a project that hard-codes one must be told $PORT. A ' +
          'preview that runs several processes — a UI and an API from one dev script — declares ' +
          `ports by name (up to ${PREVIEW_PORTS_MAX}: ["web", "api"]); the first is PORT and each is also PORT_<NAME> ` +
          '(PORT_WEB, PORT_API), each with an address of its own in the answer. Waits up to waitSeconds ' +
          'for the first port to accept connections, then answers the addresses the person opens signed ' +
          'in; with public true also a share link per port anyone holding it can open (a phone, a ' +
          'colleague, a webhook) until the preview stops. The process gets RENKEI_PREVIEW_URL (and ' +
          'RENKEI_PREVIEW_URL_<NAME>) for frameworks that need their public address or base path; an ' +
          'app that serves absolute paths (/_next/…) needs a base path set to the address’s path to ' +
          'render through the signed-in address, or use the share link. Separate previews learn each ' +
          'other’s ports and addresses as PREVIEW_<NAME>_PORT / PREVIEW_<NAME>_URL (per port too). ' +
          `At most ${PREVIEW_MAX_PER_SUBJECT} previews; a name in use must be stopped first. A preview lives a few hours past its last request and dies with the sandbox worker.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              pattern: '^[a-z][a-z0-9-]{0,31}$',
              description: 'A short name — web, api, docs — part of the address.',
            },
            command: { type: 'string', minLength: 1, maxLength: 8_000 },
            ports: {
              type: 'array',
              items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,15}$' },
              minItems: 1,
              maxItems: PREVIEW_PORTS_MAX,
              description:
                'The ports by name, first one primary (default ["app"]); each becomes PORT_<NAME> and gets its own address.',
            },
            public: {
              type: 'boolean',
              description: 'Also mint a share link that needs no sign-in.',
            },
            waitSeconds: {
              type: 'integer',
              minimum: 1,
              maximum: PREVIEW_START_WAIT_MAX_MS / 1000,
              description: 'How long to wait for the server to listen (default 60).',
            },
          },
          required: ['name', 'command'],
        },
      },
      timeoutMs: PREVIEW_START_TOOL_TIMEOUT_MS,
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const name = str(input.name);
        const portNames = validatePreviewPorts(input.ports);
        if (!portNames.ok) return errorResult(portNames.message);
        const addresses = addressesOf(context, {
          name,
          ports: portNames.ports.map((port) => ({
            name: port,
            token: input.public === true ? mintPreviewToken() : null,
          })),
        });
        const waitSeconds = num(input.waitSeconds);
        const started = await sbPreviewStart(target, {
          id: ref.id,
          name,
          command: str(input.command),
          ports: previewPortRequests(addresses),
          ...(waitSeconds !== undefined ? { waitMs: waitSeconds * 1000 } : {}),
        });
        if (!started.ok) return failed(started.err);
        const notYet = started.val.preview.ports
          .map((port) => port.name)
          .filter((port) => !started.val.listening.includes(port));
        const head = started.val.listening.length
          ? `Started and listening${notYet.length ? ` on ${started.val.listening.join(', ')} (not yet on ${notYet.join(', ')} — check code_preview_logs)` : ''}.`
          : started.val.preview.status === 'exited'
            ? `The command exited before listening${started.val.preview.exitCode !== null ? ` (code ${started.val.preview.exitCode})` : ''}; its output is below.`
            : `Started, but nothing is accepting connections on port ${started.val.preview.port} yet — it may still be building; check code_preview_logs, or make sure the server binds PORT.`;
        const body =
          `${head}\n${renderPreview(started.val.preview, addresses)}` +
          (started.val.logs ? `\n--- first lines ---\n${started.val.logs}` : '');
        return started.val.preview.status === 'exited' ? errorResult(body) : textResult(body);
      },
    },
    {
      def: {
        name: 'code_preview_logs',
        description:
          'What a preview’s server has written (both streams, each line stamped, newest last) — ' +
          `is it up, what did it serve, why did it stop. lines from the end, at most ${PREVIEW_LOG_MAX_LINES}.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
            lines: { type: 'integer', minimum: 1, maximum: PREVIEW_LOG_MAX_LINES },
          },
          required: ['name'],
        },
      },
      readOnly: true,
      async execute(input, context) {
        const lines = num(input.lines);
        const got = await sbPreviewLogs(target, {
          name: str(input.name),
          ...(lines !== undefined ? { lines } : {}),
        });
        if (!got.ok) return failed(got.err);
        return textResult(
          `${renderPreview(got.val.preview, addressesOf(context, got.val.preview))}\n` +
            `${got.val.count} line${got.val.count === 1 ? '' : 's'}${got.val.truncated ? ' [the start was cut]' : ''}\n--- logs ---\n${got.val.logs || '(nothing yet)'}`
        );
      },
    },
    {
      def: {
        name: 'code_preview_stop',
        description:
          'Stop a preview: its process tree is ended, its address and share link stop working, ' +
          'and its name is free again. Do this before starting it again after a change that needs a restart.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' } },
          required: ['name'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const stopped = await sbPreviewStop(target, str(input.name));
        if (!stopped.ok) return failed(stopped.err);
        return textResult(
          `Stopped ${stopped.val.name} (port${stopped.val.ports.length === 1 ? '' : 's'} ${stopped.val.ports.map((port) => port.port).join(', ')} back in the pool).`
        );
      },
    },
  ];
}
