/**
 * The code_* tools — how a chat inside a code project works in the
 * project's repository: look around, search, read, edit, run the
 * project's own commands, commit, push, pull. Local tools (run in this
 * process, lib/chat/local-tools.ts) rather than MCP ones, because they
 * are bound to ONE checkout — the project's — and exist nowhere else: a
 * chat outside a code project never sees them, an MCP client never sees
 * them, and no tool argument names a workspace.
 *
 * Every verb is one bounded thing the sandbox worker does inside that
 * checkout (apps/worker-sandbox/src/workspaces.ts). `code_run` is the one
 * verb that is a shell — deliberately, because a project's own commands
 * are the point — and the worker runs it as the project's own
 * unprivileged uid, in the checkout, with an environment built from
 * nothing plus the variables the project's `.env` supplied. Those are
 * the one thing a model never sees: `code_env_names` answers names, and
 * the worker masks every value out of every output before it comes back.
 *
 * Git credentials never appear here either: a push or pull asks the
 * chatting person's own grant on the project's git host (Bitbucket or
 * GitHub) for a token, hands the worker a header for that one call, and
 * keeps nothing (lib/sandbox/workspace-git.ts).
 */

import {
  EXEC_MAX_TIMEOUT_MS,
  EXEC_OUTPUT_DEFAULT_CHARS,
  EXEC_OUTPUT_MAX_CHARS,
  FIND_MAX_RESULTS,
  GREP_MAX_MATCHES,
  READ_DEFAULT_CHARS,
  READ_MAX_CHARS,
  WRITE_MAX_CHARS,
  SERVICE_ENV_MAX,
  SERVICE_EXPORT_MAX,
  SERVICE_LOGS_DEFAULT_LINES,
  SERVICE_LOGS_MAX_LINES,
  SERVICE_MAX_PER_SUBJECT,
  clipOutput,
  serviceEnvPrefix,
} from '@renkei/connector-sandbox';
import {
  clientFailure,
  type SandboxClientError,
  sbEnvList,
  sbServiceList,
  sbServiceLogs,
  sbServiceStart,
  sbServiceStop,
  sbWorkspaceEdit,
  sbWorkspaceExec,
  sbWorkspaceFind,
  sbWorkspaceGitCommit,
  sbWorkspaceGitDiff,
  sbWorkspaceGitPull,
  sbWorkspaceGitPush,
  sbWorkspaceGitStatus,
  sbWorkspaceGrep,
  sbWorkspaceLs,
  sbWorkspaceRead,
  sbWorkspaceWrite,
  type SandboxTarget,
} from '@renkei/sandbox-client';
import { errorResult, textResult, type LocalTool } from '@/lib/chat/local-tools';
import type { McpToolResult } from '@renkei/mcp-client';
import { GITHUB } from '@renkei/provider-grants';
import { commitAuthorFor, resolveWorkspaceGitCredential } from '@/lib/sandbox/workspace-git';
import { codeDelegateTool, type SubagentModelChoice } from './delegate';
import { DIFF_FENCE_CLOSE, DIFF_FENCE_OPEN } from './diff';

/** How much of a file's diff rides back on a write or edit, for the model and the page. */
const TOOL_DIFF_MAX_CHARS = 24_000;

/** A checkout made usable again mid-turn: the id to work in from now on, or why not. */
export type CheckoutRecovery =
  | { ok: true; workspaceId: string; seconds: number; how: 'cloned' | 'adopted' }
  | { ok: false; message: string };

/** What binds the tools to one project's checkout. */
export interface CodeToolBinding {
  /** The worker target the project's checkout and environment live under (lib/code/scope.ts). */
  target: SandboxTarget;
  workspaceId: string;
  repoFullName: string;
  /** ATLASSIAN_BITBUCKET or GITHUB (@renkei/provider-grants) — which grant a push/pull asks. */
  repoProvider: string;
  /** The deployment's origin, for the host's app reader when a token needs refreshing. */
  origin: string;
  /**
   * Bring the checkout back when the worker says it is gone (lib/code/turn.ts):
   * clone it again, or adopt one another turn already cloned. Absent, a
   * lost checkout is simply the error the worker gave.
   */
  recover?: (lostWorkspaceId: string) => Promise<CheckoutRecovery>;
  /**
   * The org's enabled models, for the orchestrator to pick a sub-agent's
   * from per task (lib/code/delegate.ts). Absent, a sub-agent runs on the
   * turn's own model.
   */
  subagentModels?: SubagentModelChoice[];
  /**
   * Whether the deployment lets a project start services — containers
   * beside the checkout (SANDBOX_SERVICES_ENABLED on both sides). Off,
   * the code_service_* tools do not exist in the turn.
   */
  servicesEnabled?: boolean;
}

/**
 * Times in one turn the checkout may be lost and brought back before the
 * tools stop trying: a checkout that keeps vanishing is a deployment
 * problem (its volume, its worker), not something another clone fixes.
 */
export const MAX_CHECKOUT_RECOVERIES_PER_TURN = 2;

/** The worker's word for a checkout that is not there to work in — never for a missing file. */
function checkoutLost(error: SandboxClientError): boolean {
  if (error.kind !== 'op') return false;
  if (error.type === 'not_ready') return true;
  return error.type === 'not_found' && /workspace/i.test(error.message ?? '');
}

const CHECKOUT_LOST_META = 'checkoutLost';

/**
 * The tool, with its checkout brought back when the worker says it is
 * gone. A verb that answers "not ready" (the checkout vanished from the
 * worker's disk, its row was retired, or another turn's clone is still
 * running) recovers it once — one clone, shared by every tool that hits
 * the same wall at the same time — and runs again against the new
 * checkout, saying so at the top of its answer. Past the per-turn limit,
 * every tool refuses with the same words, so the model stops rather
 * than looping on a checkout that will not stay.
 */
function withCheckoutRecovery(
  tool: LocalTool,
  state: {
    recover: (lostWorkspaceId: string) => Promise<CheckoutRecovery>;
    current: () => string;
    adopt: (workspaceId: string) => void;
    attempts: number;
    inFlight: Promise<CheckoutRecovery> | null;
    exhausted: string | null;
  }
): LocalTool {
  return {
    ...tool,
    async execute(input, context) {
      if (state.exhausted) return errorResult(state.exhausted);
      const first = await tool.execute(input, context);
      if (first.meta[CHECKOUT_LOST_META] !== true) return first;
      const giveUp = (): McpToolResult => {
        state.exhausted =
          `The checkout was lost ${state.attempts} times in this turn and is not coming back; ` +
          'the code_* tools are unavailable for the rest of it. Stop and tell the person: the sandbox worker or its workspaces volume needs looking at.';
        return errorResult(state.exhausted);
      };
      if (!state.inFlight) {
        if (state.attempts >= MAX_CHECKOUT_RECOVERIES_PER_TURN) return giveUp();
        state.attempts += 1;
        state.inFlight = state
          .recover(state.current())
          .catch((error: unknown): CheckoutRecovery => ({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          }))
          .finally(() => {
            state.inFlight = null;
          });
      }
      const recovered = await state.inFlight;
      if (!recovered.ok) {
        if (state.attempts >= MAX_CHECKOUT_RECOVERIES_PER_TURN) return giveUp();
        return errorResult(
          `${first.content[0]?.text ?? 'The checkout is gone.'} Cloning it again did not work: ${recovered.message}`
        );
      }
      state.adopt(recovered.workspaceId);
      const second = await tool.execute(input, context);
      // Brought back and gone again at once: the limit is on consecutive
      // losses, and this is one.
      if (second.meta[CHECKOUT_LOST_META] === true) {
        return state.attempts >= MAX_CHECKOUT_RECOVERIES_PER_TURN ? giveUp() : second;
      }
      const note =
        recovered.how === 'cloned'
          ? `[The checkout had gone from the sandbox; it was cloned again (${recovered.seconds}s) and this call ran again in the new one.]`
          : `[The checkout had been replaced by a newer clone (${recovered.seconds}s); this call ran again in it.]`;
      const [head, ...rest] = second.content;
      return {
        ...second,
        content: [
          { ...(head ?? { type: 'text' }), text: `${note}\n\n${head?.text ?? ''}` },
          ...rest,
        ],
      };
    },
  };
}

/** The tool name that opens a pull request on the project's git host. */
function prTool(provider: string): string {
  return provider === GITHUB ? 'github_create_pull_request' : 'bitbucket_create_pull_request';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}

/** A file's text with line numbers, the shape an edit can be aimed from. */
export function numberedLines(text: string, startLine: number): string {
  const width = String(startLine + text.split('\n').length).length;
  return text
    .split('\n')
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')}\t${line}`)
    .join('\n');
}

/** How a command's answer reads to the model: the verdict first, then both streams. */
export function renderRun(
  result: {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    durationMs: number;
    timeoutMs: number;
    unreadableEnv: string[];
  },
  maxChars: number
): { text: string; ok: boolean } {
  const head = result.timedOut
    ? `TIMED OUT after ${Math.round(result.timeoutMs / 1000)}s — the process tree was killed`
    : result.exitCode === null
      ? `killed by ${result.signal ?? 'a signal'}`
      : `exit ${result.exitCode}`;
  const notes: string[] = [];
  if (result.truncated) notes.push('output exceeded the worker’s buffer and was cut');
  if (result.unreadableEnv.length) {
    notes.push(
      `variables not set (their sealed value no longer opens): ${result.unreadableEnv.join(', ')}`
    );
  }
  const stdout = clipOutput(result.stdout.replace(/\s+$/, ''), Math.floor(maxChars * 0.7));
  const stderr = clipOutput(result.stderr.replace(/\s+$/, ''), maxChars - stdout.text.length);
  const parts = [`${head} (${(result.durationMs / 1000).toFixed(1)}s)`];
  if (notes.length) parts.push(`[${notes.join('; ')}]`);
  parts.push(`--- stdout ---\n${stdout.text || '(none)'}`);
  parts.push(`--- stderr ---\n${stderr.text || '(none)'}`);
  return { text: parts.join('\n'), ok: result.exitCode === 0 && !result.timedOut };
}

const pathProperty = (description: string) => ({
  type: 'string',
  maxLength: 1024,
  description,
});

/** How a service reads to the model: one line each, its address and what it exports. */
export function renderService(service: {
  name: string;
  image: string;
  status: string;
  host: string | null;
  ports: number[];
  exportNames: string[];
  error: string | null;
}): string {
  const prefix = serviceEnvPrefix(service.name);
  const where =
    service.status === 'running' && service.host
      ? `at ${service.host}${service.ports.length ? `:${service.ports.join(',')}` : ''} — ${prefix}_HOST${service.ports.length ? `, ${prefix}_PORT` : ''}${service.exportNames.length ? `, ${service.exportNames.join(', ')}` : ''} set for every command`
      : service.error
        ? `— ${service.error}`
        : '';
  return `${service.name} (${service.image}): ${service.status} ${where}`.trim();
}

/**
 * The code_service_* tools: containers beside the checkout, from the
 * images the organization allows. The worker decides what may run; here
 * the shape is the model's — a name, an image, the container's own
 * variables, and what to export into the project's commands.
 */
function serviceTools(
  target: SandboxTarget,
  failed: (error: SandboxClientError) => McpToolResult
): LocalTool[] {
  const envProperty = (description: string, max: number) => ({
    type: 'object',
    description,
    maxProperties: max,
    additionalProperties: { type: 'string' },
  });
  return [
    {
      def: {
        name: 'code_services',
        description:
          'The services (containers) running beside this project’s checkout — a database, a cache, ' +
          'a broker started with code_service_start — with their status, address and the variables ' +
          'they set for every code_run command. Nothing running answers so.',
        inputSchema: { type: 'object', properties: {} },
      },
      readOnly: true,
      async execute() {
        const listed = await sbServiceList(target);
        if (!listed.ok) return failed(listed.err);
        if (listed.val.length === 0) {
          return textResult(
            'No services are running for this project. code_service_start starts one from an image the organization allows.'
          );
        }
        return textResult(listed.val.map(renderService).join('\n'));
      },
    },
    {
      def: {
        name: 'code_service_start',
        description:
          'Start a service container beside the checkout for the project’s tests to use — Postgres, ' +
          'Redis, a broker — from an image the organization allows (a refusal names what is allowed). ' +
          'It is pulled and started on a private network, then reachable from every code_run command: ' +
          'SERVICE_<NAME>_HOST and SERVICE_<NAME>_PORT (the image’s declared port) are set, plus ' +
          'whatever `exports` names, rendered with {host} and {port} — e.g. ' +
          '{"DATABASE_URL": "postgres://postgres:pw@{host}:{port}/app"} — and these win over the ' +
          'project’s own .env for the commands you run. `env` configures the container itself ' +
          '(POSTGRES_PASSWORD, POSTGRES_DB, …); choose a throwaway password, it is a test database. ' +
          `A project runs at most ${SERVICE_MAX_PER_SUBJECT} services; a name in use must be stopped first. ` +
          'Give the service a moment after it starts (its own readiness, e.g. pg_isready) before running tests. ' +
          'The service is stopped and its data removed when the project is idle for a day, or with code_service_stop.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              pattern: '^[a-z][a-z0-9-]{0,31}$',
              description: 'A short name — db, cache, queue — which names the SERVICE_* variables.',
            },
            image: {
              type: 'string',
              maxLength: 512,
              description:
                'The image, as docker pull would take it: postgres:16, redis:7, myorg.azurecr.io/team/api:1.2.',
            },
            env: envProperty('The container’s own environment variables.', SERVICE_ENV_MAX),
            exports: envProperty(
              'Variables to set for every code_run command while the service runs, as templates over {host} and {port}.',
              SERVICE_EXPORT_MAX
            ),
          },
          required: ['name', 'image'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const started = await sbServiceStart(target, {
          name: str(input.name),
          image: str(input.image),
          ...(isRecord(input.env) ? { env: stringRecord(input.env) } : {}),
          ...(isRecord(input.exports) ? { exports: stringRecord(input.exports) } : {}),
        });
        if (!started.ok) return failed(started.err);
        return textResult(`Started ${renderService(started.val)}`);
      },
    },
    {
      def: {
        name: 'code_service_stop',
        description:
          'Stop a service started with code_service_start: its container is stopped and removed with ' +
          'its data, its variables leave the commands’ environment, and its name is free again.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' } },
          required: ['name'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const stopped = await sbServiceStop(target, str(input.name));
        if (!stopped.ok) return failed(stopped.err);
        return textResult(`Stopped and removed ${stopped.val.name} (${stopped.val.image}).`);
      },
    },
    {
      def: {
        name: 'code_service_logs',
        description:
          'The last lines a service wrote (both streams) — to see whether it is ready, or why it ' +
          `stopped. Default ${SERVICE_LOGS_DEFAULT_LINES} lines, at most ${SERVICE_LOGS_MAX_LINES}.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
            lines: { type: 'integer', minimum: 1, maximum: SERVICE_LOGS_MAX_LINES },
          },
          required: ['name'],
        },
      },
      readOnly: true,
      async execute(input) {
        const lines = num(input.lines);
        const got = await sbServiceLogs(target, {
          name: str(input.name),
          ...(lines !== undefined ? { lines } : {}),
        });
        if (!got.ok) return failed(got.err);
        const head = renderService(got.val.service);
        const body = got.val.logs.trim() ? got.val.logs.replace(/\s+$/, '') : '(no output yet)';
        return textResult(
          `${head}\n${got.val.truncated ? '[the start was cut]\n' : ''}--- logs ---\n${body}`
        );
      },
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      typeof entry === 'string'
        ? entry
        : entry === undefined || entry === null
          ? ''
          : String(entry);
  }
  return out;
}

export function codeTools(binding: CodeToolBinding): LocalTool[] {
  const { target } = binding;
  // Read at call time, not bound at construction: a recovery moves every
  // tool to the new checkout at once.
  let workspaceId = binding.workspaceId;
  const failed = (error: Parameters<typeof clientFailure>[0]): McpToolResult => ({
    ...errorResult(clientFailure(error).message),
    meta: checkoutLost(error) ? { [CHECKOUT_LOST_META]: true } : {},
  });

  /**
   * The file's diff against HEAD after a write or edit, fenced so the chat
   * renders it as one and the model sees exactly what changed. Best
   * effort: a diff that cannot be had leaves the result as it was.
   */
  const fencedDiffOf = async (path: string): Promise<string> => {
    const diff = await sbWorkspaceGitDiff(target, { id: workspaceId, paths: [path] });
    if (!diff.ok || !diff.val.diff.trim()) return '';
    const clipped = clipOutput(diff.val.diff, TOOL_DIFF_MAX_CHARS);
    return `\n\n${DIFF_FENCE_OPEN}${clipped.text}${DIFF_FENCE_CLOSE}`;
  };

  /** What the working tree now has changed, after a command that may have changed it. */
  const changedFilesNote = async (): Promise<string> => {
    const diff = await sbWorkspaceGitDiff(target, { id: workspaceId, statOnly: true });
    if (!diff.ok || diff.val.files.length === 0) return '';
    const lines = diff.val.files
      .slice(0, 50)
      .map(
        (file) =>
          `  +${file.added} −${file.deleted} ${file.path}${file.status === 'untracked' ? ' (new)' : ''}`
      );
    const more = diff.val.files.length > 50 ? `\n  … and ${diff.val.files.length - 50} more` : '';
    return `\n--- working tree (uncommitted changes) ---\n${lines.join('\n')}${more}`;
  };

  const tools: LocalTool[] = [
    {
      def: {
        name: 'code_clone',
        description:
          'Make sure the repository’s checkout is on the sandbox, cloning it again if it is gone. ' +
          'Normally never needed: every code_* tool brings a lost checkout back on its own before ' +
          'answering. Use it only when a tool reported the checkout gone and did not recover it. ' +
          'Never re-clones a checkout that is present, so nothing uncommitted is lost.',
        inputSchema: { type: 'object', properties: {} },
      },
      async execute() {
        // A probe, nothing more: the recovery wrapper around every tool
        // turns a "gone" answer into a clone and a second run of this.
        const listed = await sbWorkspaceLs(target, { id: workspaceId, path: '' });
        if (!listed.ok) return failed(listed.err);
        return textResult(
          `The checkout of ${binding.repoFullName} is on the sandbox and usable (${listed.val.entries.length} entries at its root); nothing to clone.`
        );
      },
    },
    {
      def: {
        name: 'code_ls',
        description:
          'The entries of one directory in the repository (files with sizes, directories, links). ' +
          'Start at the root (no path) to see the project layout; code_find takes a glob across the tree.',
        inputSchema: {
          type: 'object',
          properties: {
            path: pathProperty('Directory relative to the repository root (default: the root).'),
          },
        },
      },
      readOnly: true,
      async execute(input) {
        const listed = await sbWorkspaceLs(target, { id: workspaceId, path: str(input.path) });
        if (!listed.ok) return failed(listed.err);
        if (listed.val.entries.length === 0)
          return textResult(`${listed.val.path || '.'} is empty.`);
        return textResult(
          listed.val.entries
            .map((entry) =>
              entry.kind === 'dir'
                ? `${entry.path}/`
                : entry.kind === 'file'
                  ? `${entry.path}${entry.sizeBytes !== null ? ` (${bytes(entry.sizeBytes)})` : ''}`
                  : `${entry.path} (${entry.kind})`
            )
            .join('\n')
        );
      },
    },
    {
      def: {
        name: 'code_find',
        description:
          'Paths in the repository matching a glob ("src/**/*.ts", "**/package.json"), .gitignore ' +
          'honoured so build output and node_modules stay out unless the glob names them. ' +
          `Answers up to ${FIND_MAX_RESULTS} paths and says when there were more.`,
        inputSchema: {
          type: 'object',
          properties: {
            glob: pathProperty('Glob relative to the root (default: every file).'),
            max: { type: 'integer', minimum: 1, maximum: FIND_MAX_RESULTS },
          },
        },
      },
      readOnly: true,
      async execute(input) {
        const found = await sbWorkspaceFind(target, {
          id: workspaceId,
          glob: str(input.glob),
          ...(num(input.max) !== undefined ? { max: num(input.max) } : {}),
        });
        if (!found.ok) return failed(found.err);
        if (found.val.paths.length === 0) return textResult('No files match.');
        return textResult(
          found.val.paths.join('\n') +
            (found.val.truncated ? '\n\n(more matched — narrow the glob)' : '')
        );
      },
    },
    {
      def: {
        name: 'code_grep',
        description:
          'Search the repository’s contents for a regular expression (ripgrep syntax; fixedStrings ' +
          'for a literal), answering "path:line: text" matches. Narrow with a directory path and/or ' +
          `a glob. Answers up to ${GREP_MAX_MATCHES} matches and says when there were more.`,
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', minLength: 1, maxLength: 512 },
            path: pathProperty('Directory or file to search (default: the root).'),
            glob: pathProperty('Only files matching this glob, e.g. "*.ts".'),
            caseInsensitive: { type: 'boolean' },
            fixedStrings: {
              type: 'boolean',
              description: 'Treat the pattern as a literal string.',
            },
            max: { type: 'integer', minimum: 1, maximum: GREP_MAX_MATCHES },
          },
          required: ['pattern'],
        },
      },
      readOnly: true,
      async execute(input) {
        const found = await sbWorkspaceGrep(target, {
          id: workspaceId,
          pattern: str(input.pattern),
          path: str(input.path),
          glob: str(input.glob),
          caseInsensitive: input.caseInsensitive === true,
          fixedStrings: input.fixedStrings === true,
          ...(num(input.max) !== undefined ? { max: num(input.max) } : {}),
        });
        if (!found.ok) return failed(found.err);
        if (found.val.matches.length === 0) return textResult('No matches.');
        return textResult(
          found.val.matches
            .map((match) => `${match.path}:${match.line}: ${match.text}`)
            .join('\n') +
            (found.val.truncated ? '\n\n(more matched — narrow the pattern, path or glob)' : '')
        );
      },
    },
    {
      def: {
        name: 'code_read_file',
        description:
          'A file’s text with line numbers (the form code_edit_file is aimed from). Long files are ' +
          `read in ranges: startLine and maxLines, up to ${READ_MAX_CHARS} characters per call ` +
          `(default ${READ_DEFAULT_CHARS}). Binary files are refused.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: pathProperty('File path relative to the repository root.'),
            startLine: {
              type: 'integer',
              minimum: 1,
              description: 'First line to return (1-based).',
            },
            maxLines: { type: 'integer', minimum: 1, maximum: 20_000 },
            maxChars: { type: 'integer', minimum: 200, maximum: READ_MAX_CHARS },
          },
          required: ['path'],
        },
      },
      readOnly: true,
      async execute(input) {
        const read = await sbWorkspaceRead(target, {
          id: workspaceId,
          path: str(input.path),
          ...(num(input.startLine) !== undefined ? { startLine: num(input.startLine) } : {}),
          ...(num(input.maxLines) !== undefined ? { maxLines: num(input.maxLines) } : {}),
        });
        if (!read.ok) return failed(read.err);
        const maxChars = num(input.maxChars) ?? READ_DEFAULT_CHARS;
        const numbered = numberedLines(read.val.text, read.val.startLine);
        const cut = numbered.length > maxChars;
        const body = cut ? numbered.slice(0, maxChars) : numbered;
        const shownEnd = cut ? read.val.startLine + body.split('\n').length - 1 : read.val.endLine;
        return textResult(
          `${read.val.path} — lines ${read.val.startLine}-${shownEnd} of ${read.val.totalLines} (${bytes(read.val.sizeBytes)})` +
            (cut ? ` — cut at ${maxChars} characters; continue with startLine ${shownEnd}` : '') +
            `\n${body}`
        );
      },
    },
    {
      def: {
        name: 'code_write_file',
        description:
          'Create or replace one file with the given text (parent directories are created). For a ' +
          'change inside an existing file prefer code_edit_file, which replaces an exact snippet and ' +
          `leaves the rest untouched. At most ${WRITE_MAX_CHARS} characters; nothing under .git.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: pathProperty('File path relative to the repository root.'),
            content: { type: 'string', maxLength: WRITE_MAX_CHARS },
          },
          required: ['path', 'content'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const written = await sbWorkspaceWrite(target, {
          id: workspaceId,
          path: str(input.path),
          content: str(input.content),
        });
        if (!written.ok) return failed(written.err);
        return textResult(
          `${written.val.created ? 'Created' : 'Replaced'} ${written.val.path} (${bytes(written.val.sizeBytes)}).` +
            (await fencedDiffOf(written.val.path))
        );
      },
    },
    {
      def: {
        name: 'code_edit_file',
        description:
          'Replace one exact snippet of a file with new text. oldText must occur exactly once — ' +
          'include enough surrounding lines to make it unique (read the file first) — or pass ' +
          'replaceAll to change every occurrence. Whitespace and indentation must match the file exactly.',
        inputSchema: {
          type: 'object',
          properties: {
            path: pathProperty('File path relative to the repository root.'),
            oldText: { type: 'string', minLength: 1, maxLength: WRITE_MAX_CHARS },
            newText: { type: 'string', maxLength: WRITE_MAX_CHARS },
            replaceAll: { type: 'boolean' },
          },
          required: ['path', 'oldText', 'newText'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const edited = await sbWorkspaceEdit(target, {
          id: workspaceId,
          path: str(input.path),
          oldText: str(input.oldText),
          newText: str(input.newText),
          replaceAll: input.replaceAll === true,
        });
        if (!edited.ok) return failed(edited.err);
        return textResult(
          `Edited ${edited.val.path} (${edited.val.replacements} replacement${edited.val.replacements === 1 ? '' : 's'}).` +
            (await fencedDiffOf(edited.val.path))
        );
      },
    },
    {
      def: {
        name: 'code_run',
        description:
          'Run a bash command in the repository’s root — the project’s own commands: install ' +
          'dependencies, run tests, build, lint, a script. It runs on the sandbox worker with the ' +
          'project’s environment variables set (their values never appear in output). Answers the ' +
          `exit code and both streams, up to maxChars (default ${EXEC_OUTPUT_DEFAULT_CHARS}) with the ` +
          'middle of long output omitted. A command is killed at timeoutSeconds (default 120, max ' +
          `${EXEC_MAX_TIMEOUT_MS / 1000}) — for a slow install or test suite, say so. Not for reading ` +
          'or editing files (the dedicated tools are cheaper and safer), and git has its own tools: ' +
          'code_git_status, code_git_commit, code_git_push, code_git_pull.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', minLength: 1, maxLength: 8_000 },
            timeoutSeconds: { type: 'integer', minimum: 1, maximum: EXEC_MAX_TIMEOUT_MS / 1000 },
            maxChars: { type: 'integer', minimum: 200, maximum: EXEC_OUTPUT_MAX_CHARS },
          },
          required: ['command'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const timeout = num(input.timeoutSeconds);
        const ran = await sbWorkspaceExec(target, {
          id: workspaceId,
          command: str(input.command),
          ...(timeout !== undefined ? { timeoutMs: timeout * 1000 } : {}),
        });
        if (!ran.ok) return failed(ran.err);
        const rendered = renderRun(ran.val, num(input.maxChars) ?? EXEC_OUTPUT_DEFAULT_CHARS);
        const text = rendered.text + (await changedFilesNote());
        return rendered.ok ? textResult(text) : errorResult(text);
      },
    },
    {
      def: {
        name: 'code_git_status',
        description:
          'The current branch, changed files (git status --porcelain), and a diff summary; pass ' +
          'diff for the full unified diff against HEAD, and log for the last N commits.',
        inputSchema: {
          type: 'object',
          properties: {
            diff: { type: 'boolean', description: 'Include the full diff against HEAD.' },
            log: {
              type: 'integer',
              minimum: 1,
              maximum: 50,
              description: 'Include the last N commits.',
            },
          },
        },
      },
      readOnly: true,
      async execute(input) {
        const status = await sbWorkspaceGitStatus(target, {
          id: workspaceId,
          diff: input.diff === true,
          ...(num(input.log) !== undefined ? { log: num(input.log) } : {}),
        });
        if (!status.ok) return failed(status.err);
        const parts = [
          `Branch: ${status.val.branch}`,
          `Status:\n${status.val.status || '(clean)'}`,
        ];
        if (status.val.diffStat !== undefined)
          parts.push(`Diff summary:\n${status.val.diffStat || '(no changes)'}`);
        if (status.val.diff !== undefined)
          parts.push(`Diff:\n${status.val.diff || '(no changes)'}`);
        if (status.val.log !== undefined) parts.push(`Log:\n${status.val.log}`);
        return textResult(parts.join('\n\n'));
      },
    },
    {
      def: {
        name: 'code_git_commit',
        description:
          'Stage and commit: every change by default, or only the listed paths. newBranch creates and ' +
          'switches to a branch first — the usual way to start a change for a pull request. The commit ' +
          'is authored as the person you are talking with. Nothing leaves the sandbox until code_git_push.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 4_000 },
            paths: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 1024 },
              maxItems: 200,
            },
            newBranch: {
              type: 'string',
              maxLength: 200,
              description: 'Create this branch from the current one first.',
            },
          },
          required: ['message'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const paths = Array.isArray(input.paths)
          ? input.paths.filter((entry): entry is string => typeof entry === 'string')
          : [];
        const credential = await resolveWorkspaceGitCredential(
          {
            tenantId: context.tenantId,
            subject: context.subject,
            origin: binding.origin,
            provider: binding.repoProvider,
          },
          { write: false }
        );
        const username = typeof credential === 'string' ? '' : credential.username;
        const committed = await sbWorkspaceGitCommit(target, {
          id: workspaceId,
          message: str(input.message),
          ...(paths.length ? { paths } : {}),
          ...(str(input.newBranch) ? { newBranch: str(input.newBranch) } : {}),
          author: commitAuthorFor(
            username || context.subject,
            context.userEmail ?? undefined,
            binding.repoProvider
          ),
        });
        if (!committed.ok) return failed(committed.err);
        return textResult(`Committed on ${committed.val.branch}: ${committed.val.commit}`);
      },
    },
    {
      def: {
        name: 'code_git_push',
        description:
          'Push the current branch to origin with the person’s own access to the project’s git ' +
          'host (an upstream is set). Pass branch to push under another remote branch name. Then ' +
          `open a pull request with ${prTool(binding.repoProvider)}. Never force-pushes.`,
        inputSchema: {
          type: 'object',
          properties: {
            branch: {
              type: 'string',
              maxLength: 200,
              description: 'Remote branch name (default: the current branch).',
            },
          },
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const credential = await resolveWorkspaceGitCredential(
          {
            tenantId: context.tenantId,
            subject: context.subject,
            origin: binding.origin,
            provider: binding.repoProvider,
          },
          { write: true }
        );
        if (typeof credential === 'string') return errorResult(credential);
        const pushed = await sbWorkspaceGitPush(target, {
          id: workspaceId,
          authHeader: credential.authHeader,
          ...(str(input.branch) ? { branch: str(input.branch) } : {}),
        });
        if (!pushed.ok) return failed(pushed.err);
        return textResult(
          `Pushed ${pushed.val.branch} to origin/${pushed.val.remoteBranch}.` +
            (pushed.val.output ? `\n${pushed.val.output}` : '') +
            `\n\nTo open a pull request: ${prTool(binding.repoProvider)} on ${binding.repoFullName} with this branch as the source.`
        );
      },
    },
    {
      def: {
        name: 'code_git_pull',
        description:
          'Fast-forward the current branch from origin with the person’s own access to the ' +
          'project’s git host — or, with branch, fetch that remote branch and switch the checkout ' +
          'to it. Refuses rather than merging when the branches have diverged.',
        inputSchema: {
          type: 'object',
          properties: {
            branch: {
              type: 'string',
              maxLength: 200,
              description: 'A remote branch to fetch and switch to.',
            },
          },
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const credential = await resolveWorkspaceGitCredential(
          {
            tenantId: context.tenantId,
            subject: context.subject,
            origin: binding.origin,
            provider: binding.repoProvider,
          },
          { write: false }
        );
        if (typeof credential === 'string') return errorResult(credential);
        const pulled = await sbWorkspaceGitPull(target, {
          id: workspaceId,
          authHeader: credential.authHeader,
          ...(str(input.branch) ? { branch: str(input.branch) } : {}),
        });
        if (!pulled.ok) return failed(pulled.err);
        return textResult(
          `Now on ${pulled.val.branch}.${pulled.val.output ? `\n${pulled.val.output}` : ''}`
        );
      },
    },
    {
      def: {
        name: 'code_env_names',
        description:
          'The names of the environment variables the project’s commands run with (from the .env ' +
          'set on the project page) — names only, never values; a value is masked wherever it would ' +
          'appear in output. If a command needs one that is not here, ask the person to add it to ' +
          'the project’s .env; never ask for the value in chat and never put a secret in a command ' +
          'line or a file.',
        inputSchema: { type: 'object', properties: {} },
      },
      readOnly: true,
      async execute() {
        const listed = await sbEnvList(target);
        if (!listed.ok) return failed(listed.err);
        if (listed.val.length === 0) return textResult('The project has no environment variables.');
        return textResult(listed.val.map((variable) => variable.name).join('\n'));
      },
    },
  ];
  if (binding.servicesEnabled) tools.push(...serviceTools(target, failed));
  // One recovery state for the whole turn: the tools share the clone
  // that brings the checkout back, the count of times it was lost, and
  // the refusal once that count is spent.
  const recover = binding.recover;
  const recovery = recover
    ? {
        recover,
        current: () => workspaceId,
        adopt: (id: string) => {
          workspaceId = id;
        },
        attempts: 0,
        inFlight: null,
        exhausted: null,
      }
    : null;
  const recovering = recovery ? tools.map((tool) => withCheckoutRecovery(tool, recovery)) : tools;
  // The sub-agent gets these same tools (minus pushing and delegating),
  // on whichever of the org's models the orchestrator picks for its task.
  return [
    ...recovering,
    codeDelegateTool(recovering, {
      ...(binding.subagentModels ? { models: binding.subagentModels } : {}),
    }),
  ];
}
