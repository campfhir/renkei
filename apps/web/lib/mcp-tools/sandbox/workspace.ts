/**
 * The sandbox_workspace_* tools — a repository cloned into the sandbox
 * worker so the model can work in it the way a developer would: look
 * around, search, read, edit, run the project's own commands, commit,
 * push, open a pull request with the bitbucket_* tools. The Claude Code
 * shape, on Renkei's own sandbox (docs/sandbox-workspaces-design.md).
 *
 * Every verb is one bounded thing the WORKER does inside one checkout the
 * caller owns, addressed by its id. `sandbox_workspace_run` is the one
 * verb that is a shell — deliberately, because a project's own commands
 * (its tests, its build, its package manager) are the point — and the
 * worker runs it as the caller's own unprivileged uid, in the checkout,
 * with an environment built from nothing plus the variables the person
 * supplied on the Connectors page. Those variables are the one thing a
 * model never sees: `sandbox_workspace_list_env` answers names, and the
 * worker masks every value out of every output before it comes back.
 *
 * Git credentials never appear here either: a clone, pull or push asks
 * the person's own Bitbucket grant for a token, hands the worker a header
 * for that one call, and keeps nothing (lib/sandbox/workspace-git.ts).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CLONE_DEFAULT_DEPTH,
  EXEC_MAX_TIMEOUT_MS,
  EXEC_OUTPUT_DEFAULT_CHARS,
  EXEC_OUTPUT_MAX_CHARS,
  FIND_MAX_RESULTS,
  GREP_MAX_MATCHES,
  READ_DEFAULT_CHARS,
  READ_MAX_CHARS,
  WORKSPACE_MAX_PER_SUBJECT,
  WRITE_MAX_CHARS,
  clipOutput,
  validateRepoFullName,
} from '@renkei/connector-sandbox';
import type { MCPToolContext } from '../common';
import { errText, str, targetOf, textResult } from './shared';
import {
  bitbucketCloneUrl,
  commitAuthorFor,
  resolveWorkspaceGitCredential,
} from '@/lib/sandbox/workspace-git';
import {
  clientFailure,
  sbEnvList,
  sbWorkspaceClone,
  sbWorkspaceDelete,
  sbWorkspaceEdit,
  sbWorkspaceExec,
  sbWorkspaceFind,
  sbWorkspaceGitCommit,
  sbWorkspaceGitPull,
  sbWorkspaceGitPush,
  sbWorkspaceGitStatus,
  sbWorkspaceGrep,
  sbWorkspaceList,
  sbWorkspaceLs,
  sbWorkspaceRead,
  sbWorkspaceWrite,
  type WireWorkspace,
} from '@/lib/sandbox/service-client';

export interface WorkspaceToolOptions {
  /**
   * Whether the caller may reach Bitbucket through this surface — they
   * hold a grant and the org has not switched the connector off. Without
   * it the clone/pull/push verbs are not offered; the rest still work on
   * checkouts that already exist.
   */
  bitbucketGit: boolean;
}

const workspaceIdArg = z
  .string()
  .uuid()
  .describe('From sandbox_workspace_list or sandbox_workspace_clone.');

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}

export function workspaceLine(workspace: WireWorkspace): string {
  const state =
    workspace.status === 'ready'
      ? `ready — ${bytes(workspace.sizeBytes)}`
      : workspace.status === 'cloning'
        ? 'cloning…'
        : `clone FAILED — ${workspace.error ?? 'unknown reason'}`;
  return (
    `${workspace.id} — ${workspace.repoFullName} @ ${workspace.branch} — ${state} — ` +
    `expires ${new Date(workspace.expiresAt).toLocaleString()} (extended on use)`
  );
}

/** A file's text with line numbers, the shape an edit can be aimed from. */
export function numberedLines(text: string, startLine: number): string {
  const width = String(startLine + text.split('\n').length).length;
  return text
    .split('\n')
    .map((line, index) => `${String(startLine + index).padStart(width, ' ')}\t${line}`)
    .join('\n');
}

export function registerSandboxWorkspaceTools(
  server: McpServer,
  context: MCPToolContext,
  options: WorkspaceToolOptions
): void {
  const gitNote = options.bitbucketGit
    ? ''
    : ' Cloning, pulling and pushing need Bitbucket connected on the Connectors page; only existing workspaces are available here.';

  server.registerTool(
    'sandbox_workspace_list',
    {
      title: 'Sandbox · Read — List your code workspaces',
      description:
        'The repositories you have cloned into the sandbox, with their id, branch, state and size. ' +
        'A workspace is where sandbox_workspace_run, _read_file, _grep and the other workspace ' +
        'tools operate; a workspace still "cloning" is not usable yet — check again shortly.' +
        gitNote,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const listed = await sbWorkspaceList(target);
      if (!listed.ok) return errText(clientFailure(listed.err).message);
      if (listed.val.length === 0) {
        return textResult(
          options.bitbucketGit
            ? 'No workspaces yet — clone one with sandbox_workspace_clone (see bitbucket_list_repositories for names).'
            : 'No workspaces yet. Clone one from the Connectors page (Bitbucket must be connected).'
        );
      }
      return textResult(listed.val.map(workspaceLine).join('\n'));
    }
  );

  if (options.bitbucketGit) {
    server.registerTool(
      'sandbox_workspace_clone',
      {
        title: 'Sandbox · Act — Clone a Bitbucket repository into a workspace',
        description:
          'Clone one of your Bitbucket repositories into a new sandbox workspace, with your own ' +
          'Bitbucket access. The clone runs on the worker in the background: this answers at once ' +
          'with the workspace id and "cloning", and sandbox_workspace_list reports when it is ready ' +
          `(or why it failed). At most ${WORKSPACE_MAX_PER_SUBJECT} workspaces at once — delete one ` +
          'with sandbox_workspace_delete if you need room. A shallow clone (the last ' +
          `${CLONE_DEFAULT_DEPTH} commits) is the default; depth 0 fetches all history.`,
        annotations: { readOnlyHint: false },
        inputSchema: z.object({
          repository: z
            .string()
            .min(3)
            .max(201)
            .describe(
              'workspace/repo-slug, e.g. "acme/billing-service" (from bitbucket_list_repositories).'
            ),
          branch: z
            .string()
            .max(200)
            .optional()
            .describe('Branch to check out (default: the repository’s main branch).'),
          depth: z
            .number()
            .int()
            .min(0)
            .max(10_000)
            .optional()
            .describe(
              `Commits of history to fetch (default ${CLONE_DEFAULT_DEPTH}; 0 = everything).`
            ),
        }),
      },
      async (args: Record<string, unknown>) => {
        const target = targetOf(context);
        if (typeof target === 'string') return errText(target);
        const repo = validateRepoFullName(args.repository);
        if (!repo.ok) return errText(repo.message);
        const credential = await resolveWorkspaceGitCredential(context, { write: false });
        if (typeof credential === 'string') return errText(credential);
        const cloned = await sbWorkspaceClone(target, {
          provider: 'atlassian-bitbucket',
          repoFullName: repo.fullName,
          ...(str(args.branch) ? { branch: str(args.branch) } : {}),
          ...(typeof args.depth === 'number' ? { depth: args.depth } : {}),
          cloneUrl: bitbucketCloneUrl(repo.workspace, repo.repoSlug),
          authHeader: credential.authHeader,
        });
        if (!cloned.ok) return errText(clientFailure(cloned.err).message);
        return textResult(
          `Cloning ${cloned.val.repoFullName} into workspace ${cloned.val.id}. ` +
            'It runs in the background — call sandbox_workspace_list in a moment; the workspace is usable once it reads "ready".'
        );
      }
    );
  }

  server.registerTool(
    'sandbox_workspace_delete',
    {
      title: 'Sandbox · Act — Delete a workspace',
      description:
        'Remove a workspace and its checkout from the sandbox. Uncommitted or unpushed work in it is lost.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ workspaceId: workspaceIdArg }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const deleted = await sbWorkspaceDelete(target, str(args.workspaceId));
      if (!deleted.ok) return errText(clientFailure(deleted.err).message);
      return textResult(`Deleted workspace ${deleted.val.id} (${deleted.val.repoFullName}).`);
    }
  );

  server.registerTool(
    'sandbox_workspace_ls',
    {
      title: 'Sandbox · Read — List a directory in a workspace',
      description:
        'The entries of one directory in the checkout (files with sizes, directories, links). ' +
        'Start at the root (no path) to see the project layout; use sandbox_workspace_find for a glob across the tree.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspaceId: workspaceIdArg,
        path: z
          .string()
          .max(1024)
          .optional()
          .describe('Directory relative to the root (default: the root).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const listed = await sbWorkspaceLs(target, {
        id: str(args.workspaceId),
        path: str(args.path),
      });
      if (!listed.ok) return errText(clientFailure(listed.err).message);
      if (listed.val.entries.length === 0) return textResult(`${listed.val.path || '.'} is empty.`);
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
    }
  );

  server.registerTool(
    'sandbox_workspace_find',
    {
      title: 'Sandbox · Read — Find files by glob in a workspace',
      description:
        'Paths in the checkout matching a glob ("src/**/*.ts", "**/package.json"), .gitignore ' +
        'honoured so build output and node_modules stay out unless the glob names them. ' +
        `Answers up to ${FIND_MAX_RESULTS} paths and says when there were more.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspaceId: workspaceIdArg,
        glob: z
          .string()
          .max(1024)
          .optional()
          .describe('Glob relative to the root (default: every file).'),
        max: z.number().int().min(1).max(FIND_MAX_RESULTS).optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const found = await sbWorkspaceFind(target, {
        id: str(args.workspaceId),
        glob: str(args.glob),
        ...(typeof args.max === 'number' ? { max: args.max } : {}),
      });
      if (!found.ok) return errText(clientFailure(found.err).message);
      if (found.val.paths.length === 0) return textResult('No files match.');
      return textResult(
        found.val.paths.join('\n') +
          (found.val.truncated ? '\n\n(more matched — narrow the glob)' : '')
      );
    }
  );

  server.registerTool(
    'sandbox_workspace_grep',
    {
      title: 'Sandbox · Read — Search file contents in a workspace',
      description:
        'Search the checkout for a regular expression (ripgrep syntax; fixedStrings for a literal), ' +
        'answering "path:line: text" matches. Narrow with a directory path and/or a glob. ' +
        `Answers up to ${GREP_MAX_MATCHES} matches and says when there were more.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspaceId: workspaceIdArg,
        pattern: z.string().min(1).max(512),
        path: z
          .string()
          .max(1024)
          .optional()
          .describe('Directory or file to search (default: the root).'),
        glob: z
          .string()
          .max(1024)
          .optional()
          .describe('Only files matching this glob, e.g. "*.ts".'),
        caseInsensitive: z.boolean().optional(),
        fixedStrings: z.boolean().optional().describe('Treat the pattern as a literal string.'),
        max: z.number().int().min(1).max(GREP_MAX_MATCHES).optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const found = await sbWorkspaceGrep(target, {
        id: str(args.workspaceId),
        pattern: str(args.pattern),
        path: str(args.path),
        glob: str(args.glob),
        caseInsensitive: args.caseInsensitive === true,
        fixedStrings: args.fixedStrings === true,
        ...(typeof args.max === 'number' ? { max: args.max } : {}),
      });
      if (!found.ok) return errText(clientFailure(found.err).message);
      if (found.val.matches.length === 0) return textResult('No matches.');
      return textResult(
        found.val.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n') +
          (found.val.truncated ? '\n\n(more matched — narrow the pattern, path or glob)' : '')
      );
    }
  );

  server.registerTool(
    'sandbox_workspace_read_file',
    {
      title: 'Sandbox · Read — Read a file in a workspace',
      description:
        'A file’s text with line numbers (the form sandbox_workspace_edit_file is aimed from). ' +
        `Long files are read in ranges: startLine and maxLines, up to ${READ_MAX_CHARS} characters ` +
        `per call (default ${READ_DEFAULT_CHARS}). Binary files are refused.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspaceId: workspaceIdArg,
        path: z.string().min(1).max(1024).describe('File path relative to the root.'),
        startLine: z.number().int().min(1).optional().describe('First line to return (1-based).'),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(20_000)
          .optional()
          .describe('How many lines (default: to the cap).'),
        maxChars: z.number().int().min(200).max(READ_MAX_CHARS).optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const read = await sbWorkspaceRead(target, {
        id: str(args.workspaceId),
        path: str(args.path),
        ...(typeof args.startLine === 'number' ? { startLine: args.startLine } : {}),
        ...(typeof args.maxLines === 'number' ? { maxLines: args.maxLines } : {}),
      });
      if (!read.ok) return errText(clientFailure(read.err).message);
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : READ_DEFAULT_CHARS;
      const numbered = numberedLines(read.val.text, read.val.startLine);
      const cut = numbered.length > maxChars;
      const body = cut ? numbered.slice(0, maxChars) : numbered;
      const shownEnd = cut ? read.val.startLine + body.split('\n').length - 1 : read.val.endLine;
      return textResult(
        `${read.val.path} — lines ${read.val.startLine}-${shownEnd} of ${read.val.totalLines} (${bytes(read.val.sizeBytes)})` +
          (cut ? ` — cut at ${maxChars} characters; continue with startLine ${shownEnd}` : '') +
          `\n${body}`
      );
    }
  );

  server.registerTool(
    'sandbox_workspace_write_file',
    {
      title: 'Sandbox · Act — Write a file in a workspace',
      description:
        'Create or replace one file with the given text (parent directories are created). For a ' +
        'change inside an existing file prefer sandbox_workspace_edit_file, which replaces an exact ' +
        `snippet and leaves the rest untouched. At most ${WRITE_MAX_CHARS} characters; nothing under .git.`,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspaceId: workspaceIdArg,
        path: z.string().min(1).max(1024),
        content: z.string().max(WRITE_MAX_CHARS),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const written = await sbWorkspaceWrite(target, {
        id: str(args.workspaceId),
        path: str(args.path),
        content: str(args.content),
      });
      if (!written.ok) return errText(clientFailure(written.err).message);
      return textResult(
        `${written.val.created ? 'Created' : 'Replaced'} ${written.val.path} (${bytes(written.val.sizeBytes)}).`
      );
    }
  );

  server.registerTool(
    'sandbox_workspace_edit_file',
    {
      title: 'Sandbox · Act — Edit a file in a workspace by exact replacement',
      description:
        'Replace one exact snippet of a file with new text. oldText must occur exactly once — ' +
        'include enough surrounding lines to make it unique (read the file first) — or pass ' +
        'replaceAll to change every occurrence. Whitespace and indentation must match the file exactly.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspaceId: workspaceIdArg,
        path: z.string().min(1).max(1024),
        oldText: z.string().min(1).max(WRITE_MAX_CHARS),
        newText: z.string().max(WRITE_MAX_CHARS),
        replaceAll: z.boolean().optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const edited = await sbWorkspaceEdit(target, {
        id: str(args.workspaceId),
        path: str(args.path),
        oldText: str(args.oldText),
        newText: str(args.newText),
        replaceAll: args.replaceAll === true,
      });
      if (!edited.ok) return errText(clientFailure(edited.err).message);
      return textResult(
        `Edited ${edited.val.path} (${edited.val.replacements} replacement${edited.val.replacements === 1 ? '' : 's'}).`
      );
    }
  );

  server.registerTool(
    'sandbox_workspace_run',
    {
      title: 'Sandbox · Act — Run a shell command in a workspace',
      description:
        'Run a bash command in the checkout’s root — the project’s own commands: install ' +
        'dependencies, run tests, build, lint, a script. It runs on the sandbox worker as you, ' +
        'with your environment variables from the Connectors page set (their values never appear in ' +
        `output). Answers the exit code and both streams, up to maxChars (default ${EXEC_OUTPUT_DEFAULT_CHARS}) ` +
        `with the middle of long output omitted. A command is killed at timeoutSeconds (default 120, ` +
        `max ${EXEC_MAX_TIMEOUT_MS / 1000}) — for a slow install or test suite, say so. Not for ` +
        'reading or editing files (use the dedicated tools; they are cheaper and safer), and git ' +
        'has its own tools: sandbox_workspace_git_status/_commit/_push/_pull.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspaceId: workspaceIdArg,
        command: z.string().min(1).max(8_000),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(EXEC_MAX_TIMEOUT_MS / 1000)
          .optional(),
        maxChars: z.number().int().min(200).max(EXEC_OUTPUT_MAX_CHARS).optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const ran = await sbWorkspaceExec(target, {
        id: str(args.workspaceId),
        command: str(args.command),
        ...(typeof args.timeoutSeconds === 'number'
          ? { timeoutMs: args.timeoutSeconds * 1000 }
          : {}),
      });
      if (!ran.ok) return errText(clientFailure(ran.err).message);
      const maxChars =
        typeof args.maxChars === 'number' ? args.maxChars : EXEC_OUTPUT_DEFAULT_CHARS;
      const result = ran.val;
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
      const text = parts.join('\n');
      return result.exitCode === 0 && !result.timedOut ? textResult(text) : errText(text);
    }
  );

  server.registerTool(
    'sandbox_workspace_git_status',
    {
      title: 'Sandbox · Read — Git status of a workspace',
      description:
        'The current branch, changed files (git status --porcelain), and a diff summary; pass ' +
        'diff for the full unified diff against HEAD, and log for the last N commits.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspaceId: workspaceIdArg,
        diff: z.boolean().optional().describe('Include the full diff against HEAD.'),
        log: z.number().int().min(1).max(50).optional().describe('Include the last N commits.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const status = await sbWorkspaceGitStatus(target, {
        id: str(args.workspaceId),
        diff: args.diff === true,
        ...(typeof args.log === 'number' ? { log: args.log } : {}),
      });
      if (!status.ok) return errText(clientFailure(status.err).message);
      const parts = [`Branch: ${status.val.branch}`, `Status:\n${status.val.status || '(clean)'}`];
      if (status.val.diffStat !== undefined)
        parts.push(`Diff summary:\n${status.val.diffStat || '(no changes)'}`);
      if (status.val.diff !== undefined) parts.push(`Diff:\n${status.val.diff || '(no changes)'}`);
      if (status.val.log !== undefined) parts.push(`Log:\n${status.val.log}`);
      return textResult(parts.join('\n\n'));
    }
  );

  server.registerTool(
    'sandbox_workspace_git_commit',
    {
      title: 'Sandbox · Act — Commit changes in a workspace',
      description:
        'Stage and commit: every change by default, or only the listed paths. newBranch creates and ' +
        'switches to a branch first — the usual way to start a change for a pull request. The commit ' +
        'is authored as you. Nothing leaves the sandbox until sandbox_workspace_git_push.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspaceId: workspaceIdArg,
        message: z.string().min(1).max(4_000),
        paths: z.array(z.string().min(1).max(1024)).max(200).optional(),
        newBranch: z
          .string()
          .max(200)
          .optional()
          .describe('Create this branch from the current one first.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((p): p is string => typeof p === 'string')
        : [];
      const committed = await sbWorkspaceGitCommit(target, {
        id: str(args.workspaceId),
        message: str(args.message),
        ...(paths.length ? { paths } : {}),
        ...(str(args.newBranch) ? { newBranch: str(args.newBranch) } : {}),
        author: commitAuthorFor(context.subject ?? '', context.userEmail),
      });
      if (!committed.ok) return errText(clientFailure(committed.err).message);
      return textResult(`Committed on ${committed.val.branch}: ${committed.val.commit}`);
    }
  );

  if (options.bitbucketGit) {
    server.registerTool(
      'sandbox_workspace_git_push',
      {
        title: 'Sandbox · Act — Push a workspace branch to Bitbucket',
        description:
          'Push the current branch to origin with your own Bitbucket access (an upstream is set). ' +
          'Pass branch to push under another remote branch name. Then open a pull request with ' +
          'bitbucket_create_pull_request. Never force-pushes.',
        annotations: { readOnlyHint: false },
        inputSchema: z.object({
          workspaceId: workspaceIdArg,
          branch: z
            .string()
            .max(200)
            .optional()
            .describe('Remote branch name (default: the current branch).'),
        }),
      },
      async (args: Record<string, unknown>) => {
        const target = targetOf(context);
        if (typeof target === 'string') return errText(target);
        const credential = await resolveWorkspaceGitCredential(context, { write: true });
        if (typeof credential === 'string') return errText(credential);
        const pushed = await sbWorkspaceGitPush(target, {
          id: str(args.workspaceId),
          authHeader: credential.authHeader,
          ...(str(args.branch) ? { branch: str(args.branch) } : {}),
        });
        if (!pushed.ok) return errText(clientFailure(pushed.err).message);
        return textResult(
          `Pushed ${pushed.val.branch} to origin/${pushed.val.remoteBranch}.` +
            (pushed.val.output ? `\n${pushed.val.output}` : '') +
            '\n\nTo open a pull request: bitbucket_create_pull_request with this branch as the source.'
        );
      }
    );

    server.registerTool(
      'sandbox_workspace_git_pull',
      {
        title: 'Sandbox · Act — Pull from Bitbucket into a workspace',
        description:
          'Fast-forward the current branch from origin with your own Bitbucket access — or, with ' +
          'branch, fetch that remote branch and switch the workspace to it. Refuses rather than ' +
          'merging when the branches have diverged.',
        annotations: { readOnlyHint: false },
        inputSchema: z.object({
          workspaceId: workspaceIdArg,
          branch: z
            .string()
            .max(200)
            .optional()
            .describe('A remote branch to fetch and switch to.'),
        }),
      },
      async (args: Record<string, unknown>) => {
        const target = targetOf(context);
        if (typeof target === 'string') return errText(target);
        const credential = await resolveWorkspaceGitCredential(context, { write: false });
        if (typeof credential === 'string') return errText(credential);
        const pulled = await sbWorkspaceGitPull(target, {
          id: str(args.workspaceId),
          authHeader: credential.authHeader,
          ...(str(args.branch) ? { branch: str(args.branch) } : {}),
        });
        if (!pulled.ok) return errText(clientFailure(pulled.err).message);
        return textResult(
          `Now on ${pulled.val.branch}.${pulled.val.output ? `\n${pulled.val.output}` : ''}`
        );
      }
    );
  }

  server.registerTool(
    'sandbox_workspace_list_env',
    {
      title: 'Sandbox · Read — List your workspace environment variables',
      description:
        'The names of the environment variables set for your workspace commands (supplied on the ' +
        'Connectors page) — names only, never values; a value is masked wherever it would appear in ' +
        'output. If a command needs one that is not here, ask the person to add it there; never ask ' +
        'for the value in chat and never put a secret in a command line or a file.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const listed = await sbEnvList(target);
      if (!listed.ok) return errText(clientFailure(listed.err).message);
      if (listed.val.length === 0)
        return textResult('No environment variables are set for your workspaces.');
      return textResult(
        listed.val
          .map(
            (variable) =>
              `${variable.name}${variable.lastUsedAt ? ` — last used ${new Date(variable.lastUsedAt).toLocaleString()}` : ''}`
          )
          .join('\n')
      );
    }
  );
}
