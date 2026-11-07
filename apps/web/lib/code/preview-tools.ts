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
  PREVIEW_START_WAIT_MAX_MS,
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
import { mintPreviewToken, previewAddresses } from './previews';

export interface PreviewToolDeps {
  target: SandboxTarget;
  ref: { id: string };
  /** The deployment's origin, which the addresses hang off. */
  origin: string;
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

/** One preview as the model reads it: name, state, port, the address — never the token on its own. */
export function renderPreview(
  preview: WirePreview,
  addresses: { url: string; publicUrl: string | null }
): string {
  const state =
    preview.status === 'exited'
      ? `exited${preview.exitCode !== null ? ` (code ${preview.exitCode})` : ''}${preview.signal ? ` (${preview.signal})` : ''}`
      : preview.status;
  return (
    `${preview.name}: ${state}, port ${preview.port}, \`${preview.command}\`` +
    (preview.status === 'exited'
      ? ''
      : `\n  open: ${addresses.url}` +
        (addresses.publicUrl ? `\n  share link (no sign-in): ${addresses.publicUrl}` : '') +
        `\n  until ${preview.expiresAt} unless requested again`)
  );
}

export function previewTools(deps: PreviewToolDeps): LocalTool[] {
  const { target, ref, failed } = deps;
  const addressesOf = (
    context: { projectId: string | null; chatId: string },
    preview: { name: string; token: string | null }
  ) =>
    previewAddresses(deps.origin, {
      projectId: context.projectId ?? '',
      chatId: context.chatId,
      name: preview.name,
      token: preview.token,
    });

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
          '0.0.0.0 (or the given PORT and HOST); pass port only when the project insists on one. ' +
          'Waits up to waitSeconds for the server to accept connections, then answers the address ' +
          'the person opens signed in; with public true also a share link anyone holding it can ' +
          'open (a phone, a colleague, a webhook) until the preview stops. The process gets ' +
          'RENKEI_PREVIEW_URL for frameworks that need their public address or base path; an app ' +
          'that serves absolute paths (/_next/…) needs a base path set to the address’s path to ' +
          'render through the signed-in address, or use the share link. A UI and an API are two ' +
          'previews (one process and one port each): every preview and every code_run command gets ' +
          'PREVIEW_<NAME>_PORT (the other’s loopback port, for a dev server that proxies /api to it) ' +
          'and PREVIEW_<NAME>_URL (the address a browser reaches it at, for a UI that calls its API ' +
          'directly) — start the API first, then the UI with its API address from those. ' +
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
            port: {
              type: 'integer',
              minimum: 1024,
              maximum: 65535,
              description: 'Only when the project hard-codes its port.',
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
        const token = input.public === true ? mintPreviewToken() : null;
        const addresses = addressesOf(context, { name, token });
        const waitSeconds = num(input.waitSeconds);
        const started = await sbPreviewStart(target, {
          id: ref.id,
          name,
          command: str(input.command),
          ...(num(input.port) !== undefined ? { port: num(input.port) } : {}),
          ...(token ? { token } : {}),
          url: addresses.publicUrl ?? addresses.url,
          ...(waitSeconds !== undefined ? { waitMs: waitSeconds * 1000 } : {}),
        });
        if (!started.ok) return failed(started.err);
        const head = started.val.listening
          ? `Started and listening.`
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
        return textResult(`Stopped ${stopped.val.name} (port ${stopped.val.port} is free again).`);
      },
    },
  ];
}
