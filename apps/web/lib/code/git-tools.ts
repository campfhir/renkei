/**
 * The rest of git as code_* tools — history, the remote, branches,
 * rebase and merge, stash, reset, clean, sparse checkout — beside the
 * four tools.ts has always had (status, commit, push, pull). Local tools
 * bound to the chat's worktree like the others; every verb is one bounded
 * thing the sandbox worker does (apps/worker-sandbox/src/git-verbs.ts),
 * and a remote operation spends the chatting person's own grant for one
 * call, exactly as a push does.
 *
 * Rebase and merge are shaped for the way a developer finishes one: the
 * answer says whether it completed or stopped on conflicts and in which
 * files, and the same tool continues, skips or aborts. The tool
 * descriptions carry the warnings (reset and clean discard work) so the
 * model says what will go before it goes.
 */

import {
  GIT_LOG_DEFAULT_COUNT,
  GIT_LOG_MAX_COUNT,
  SPARSE_PATHS_MAX,
  STASH_MAX_INDEX,
} from '@renkei/connector-sandbox';
import {
  sbWorkspaceGitBranch,
  sbWorkspaceGitClean,
  sbWorkspaceGitFetch,
  sbWorkspaceGitLog,
  sbWorkspaceGitMerge,
  sbWorkspaceGitRebase,
  sbWorkspaceGitReset,
  sbWorkspaceGitSparseCheckout,
  sbWorkspaceGitStash,
  type SandboxClientError,
  type SandboxTarget,
  type WireGitOperationOutcome,
} from '@renkei/sandbox-client';
import {
  errorResult,
  textResult,
  type LocalTool,
  type LocalToolContext,
} from '@/lib/chat/local-tools';
import type { McpToolResult } from '@renkei/mcp-client';
import { commitAuthorFor, resolveWorkspaceGitAccess } from '@/lib/sandbox/workspace-git';

export interface GitToolDeps {
  target: SandboxTarget;
  /** The checkout the tools work in, read at call time (a recovery moves it). */
  ref: { id: string };
  origin: string;
  repoProvider: string;
  failed: (error: SandboxClientError) => McpToolResult;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The allowed word a caller passed, or the fallback — no assertion, the list decides. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

const pathsProperty = (description: string) => ({
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 1024 },
  maxItems: 200,
  description,
});

const revisionProperty = (description: string) => ({
  type: 'string',
  maxLength: 200,
  description,
});

/** How a rebase or merge step reads to the model: done, stopped on conflicts, or nothing to do. */
export function renderOperation(
  what: 'Rebase' | 'Merge',
  tool: string,
  outcome: WireGitOperationOutcome
): { text: string; ok: boolean } {
  if (outcome.completed) {
    return {
      ok: true,
      text: `${what} completed; now on ${outcome.branch}.${outcome.output ? `\n${outcome.output}` : ''}`,
    };
  }
  if (outcome.inProgress) {
    const files = outcome.conflicts.length ? outcome.conflicts.join(', ') : '(none left)';
    return {
      ok: true,
      text:
        `${what} in progress on ${outcome.branch} — stopped on conflicts in: ${files}.\n` +
        `Resolve each file with code_read_file and code_edit_file (take out the <<<<<<<, ======= and >>>>>>> markers, keep the intended result), ` +
        `then ${tool} with action "continue" (the resolved files are staged for you); ` +
        `"abort" returns the branch to where it was${what === 'Rebase' ? ', "skip" drops the commit being applied' : ''}.` +
        (outcome.output ? `\n--- git ---\n${outcome.output}` : ''),
    };
  }
  return { ok: false, text: outcome.output || `${what} did not complete.` };
}

export function moreGitTools(deps: GitToolDeps): LocalTool[] {
  const { target, ref, failed } = deps;

  /** The person a commit git makes on their behalf is authored as — rebase and merge make commits too. */
  const authorFor = async (context: LocalToolContext) => {
    const credential = await resolveWorkspaceGitAccess(
      { subject: context.subject, origin: deps.origin, provider: deps.repoProvider },
      { write: false }
    );
    const username = typeof credential === 'string' ? '' : credential.username;
    return commitAuthorFor(
      username || context.subject,
      context.userEmail ?? undefined,
      deps.repoProvider
    );
  };

  /** A read ticket on the project's host for one fetch, or the refusal to show. */
  const readTicket = async (context: LocalToolContext) => {
    const credential = await resolveWorkspaceGitAccess(
      { subject: context.subject, origin: deps.origin, provider: deps.repoProvider },
      { write: false }
    );
    return typeof credential === 'string' ? credential : credential.gitProxy;
  };

  return [
    {
      def: {
        name: 'code_git_log',
        description:
          'The commit history as a list, newest first: hash, date, author, subject, and the branch ' +
          'or tag names at each. Narrow it with ref (a branch, a hash, or a range such as ' +
          '"origin/main..HEAD" for what this branch adds), paths (only commits touching them), ' +
          'grep (subjects matching a word, case-insensitive) or author; page with max ' +
          `(default ${GIT_LOG_DEFAULT_COUNT}, at most ${GIT_LOG_MAX_COUNT}) and skip; all walks every branch.`,
        inputSchema: {
          type: 'object',
          properties: {
            ref: revisionProperty('A revision or range (default HEAD).'),
            paths: pathsProperty('Only commits that touch these paths.'),
            grep: { type: 'string', maxLength: 200 },
            author: { type: 'string', maxLength: 200 },
            max: { type: 'integer', minimum: 1, maximum: GIT_LOG_MAX_COUNT },
            skip: { type: 'integer', minimum: 0 },
            all: { type: 'boolean', description: 'Every branch, not just ref.' },
          },
        },
      },
      readOnly: true,
      async execute(input) {
        const logged = await sbWorkspaceGitLog(target, {
          id: ref.id,
          ...(str(input.ref) ? { ref: str(input.ref) } : {}),
          ...(strings(input.paths).length ? { paths: strings(input.paths) } : {}),
          ...(str(input.grep) ? { grep: str(input.grep) } : {}),
          ...(str(input.author) ? { author: str(input.author) } : {}),
          ...(num(input.max) !== undefined ? { max: num(input.max) } : {}),
          ...(num(input.skip) !== undefined ? { skip: num(input.skip) } : {}),
          ...(input.all === true ? { all: true } : {}),
        });
        if (!logged.ok) return failed(logged.err);
        if (logged.val.commits.length === 0) return textResult('No commits match.');
        const lines = logged.val.commits.map(
          (commit) =>
            `${commit.shortSha} ${commit.date.slice(0, 10)} ${commit.author}: ${commit.subject}` +
            (commit.refs.length ? ` [${commit.refs.join(', ')}]` : '') +
            (commit.parents.length > 1 ? ' (merge)' : '')
        );
        return textResult(
          `On ${logged.val.branch}:\n${lines.join('\n')}` +
            (logged.val.truncated ? '\n\n(more — pass skip, or narrow with ref or paths)' : '')
        );
      },
    },
    {
      def: {
        name: 'code_git_fetch',
        description:
          'Fetch origin with the person’s own access to the project’s git host, so origin/<branch> ' +
          'names are current — before a rebase onto origin/main, or to see what others pushed ' +
          '(code_git_log with ref "origin/main"). Nothing in the working tree changes. branch ' +
          'fetches one branch; prune forgets remote branches that are gone.',
        inputSchema: {
          type: 'object',
          properties: {
            branch: { type: 'string', maxLength: 200 },
            prune: { type: 'boolean' },
          },
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const ticket = await readTicket(context);
        if (typeof ticket === 'string') return errorResult(ticket);
        const fetched = await sbWorkspaceGitFetch(target, {
          id: ref.id,
          gitProxy: ticket,
          ...(str(input.branch) ? { branch: str(input.branch) } : {}),
          ...(input.prune === true ? { prune: true } : {}),
        });
        if (!fetched.ok) return failed(fetched.err);
        return textResult(`Fetched origin.\n${fetched.val.output}`);
      },
    },
    {
      def: {
        name: 'code_git_branch',
        description:
          'Branches of the checkout. action "list" (the default) names the local branches with ' +
          'their upstreams and the remote-tracking ones; "create" makes name at start (default ' +
          'HEAD) without switching; "switch" checks name out — a remote branch by its short name ' +
          'becomes a tracking branch, and with create true a new branch is made at start first; ' +
          '"delete" removes a local branch (force even when unmerged). Switching with uncommitted ' +
          'changes that would be overwritten is refused by git; stash or commit first.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'switch', 'delete'] },
            name: { type: 'string', maxLength: 200 },
            start: revisionProperty('Where a new branch starts (default HEAD).'),
            create: { type: 'boolean', description: 'With switch: make the branch first.' },
            force: { type: 'boolean', description: 'With delete: even when unmerged.' },
          },
        },
      },
      async execute(input, context) {
        const action = oneOf(input.action, ['list', 'create', 'switch', 'delete'], 'list');
        if (action !== 'list' && context.readOnly) {
          return errorResult('The organization is in read-only mode.');
        }
        const branched = await sbWorkspaceGitBranch(target, {
          id: ref.id,
          action,
          ...(str(input.name) ? { name: str(input.name) } : {}),
          ...(str(input.start) ? { start: str(input.start) } : {}),
          ...(input.create === true ? { create: true } : {}),
          ...(input.force === true ? { force: true } : {}),
        });
        if (!branched.ok) return failed(branched.err);
        if (action === 'list') {
          const local = branched.val.local.map(
            (branch) =>
              `${branch.current ? '* ' : '  '}${branch.name}${branch.upstream ? ` → ${branch.upstream}` : ''} ${branch.sha} ${branch.subject}`
          );
          const remote = branched.val.remote.map(
            (branch) => `  ${branch.name} ${branch.sha} ${branch.subject}`
          );
          return textResult(
            `Local:\n${local.join('\n') || '  (none)'}\n\nRemote (as of the last fetch):\n${remote.join('\n') || '  (none)'}`
          );
        }
        return textResult(`Now on ${branched.val.branch}.\n${branched.val.output}`.trim());
      },
    },
    {
      def: {
        name: 'code_git_rebase',
        description:
          'Rebase the current branch: action "start" replays its commits onto onto (a branch, ' +
          'origin/<branch> after code_git_fetch, or a hash; autostash sets uncommitted work aside ' +
          'and back). When it stops on conflicts the answer names the files: fix each with the file ' +
          'tools, then "continue" (the fixed files are staged for you), or "skip" that commit, or ' +
          '"abort" to return to where the branch was. Afterwards the remote branch no longer ' +
          'matches: push with forceWithLease — on your own branch only, never on a shared one.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'continue', 'skip', 'abort'] },
            onto: revisionProperty('With start: what to rebase onto.'),
            autostash: { type: 'boolean' },
          },
          required: ['action'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const rebased = await sbWorkspaceGitRebase(target, {
          id: ref.id,
          action: oneOf(input.action, ['start', 'continue', 'skip', 'abort'], 'start'),
          ...(str(input.onto) ? { onto: str(input.onto) } : {}),
          ...(input.autostash === true ? { autostash: true } : {}),
          author: await authorFor(context),
        });
        if (!rebased.ok) return failed(rebased.err);
        const rendered = renderOperation('Rebase', 'code_git_rebase', rebased.val);
        return rendered.ok ? textResult(rendered.text) : errorResult(rendered.text);
      },
    },
    {
      def: {
        name: 'code_git_merge',
        description:
          'Merge ref (a branch, origin/<branch>, a hash) into the current branch: action "start" ' +
          '(noFastForward keeps a merge commit, squash stages the changes without committing, ' +
          'message names the merge commit). When it stops on conflicts the answer names the files: ' +
          'fix each with the file tools, then "continue" (they are staged for you), or "abort".',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'continue', 'abort'] },
            ref: revisionProperty('With start: what to merge in.'),
            message: { type: 'string', maxLength: 4_000 },
            noFastForward: { type: 'boolean' },
            squash: { type: 'boolean' },
          },
          required: ['action'],
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const merged = await sbWorkspaceGitMerge(target, {
          id: ref.id,
          action: oneOf(input.action, ['start', 'continue', 'abort'], 'start'),
          ...(str(input.ref) ? { ref: str(input.ref) } : {}),
          ...(str(input.message) ? { message: str(input.message) } : {}),
          ...(input.noFastForward === true ? { noFastForward: true } : {}),
          ...(input.squash === true ? { squash: true } : {}),
          author: await authorFor(context),
        });
        if (!merged.ok) return failed(merged.err);
        const rendered = renderOperation('Merge', 'code_git_merge', merged.val);
        return rendered.ok ? textResult(rendered.text) : errorResult(rendered.text);
      },
    },
    {
      def: {
        name: 'code_git_reset',
        description:
          'Move the current branch to target (default HEAD): mode "soft" keeps the changes staged ' +
          '(undo a commit, keep its work), "mixed" (the default) keeps them in the working tree, ' +
          '"keep" moves while preserving uncommitted work, "hard" DISCARDS every uncommitted ' +
          'change and every commit after target — irreversible, so say what will go first. With ' +
          'paths, only those files are unstaged and the branch does not move. Never reset a ' +
          'branch others have pulled.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['soft', 'mixed', 'hard', 'keep'] },
            target: revisionProperty(
              'Where the branch goes (default HEAD; "HEAD~1" undoes the last commit).'
            ),
            paths: pathsProperty('Unstage these files only.'),
          },
        },
      },
      async execute(input, context) {
        if (context.readOnly) return errorResult('The organization is in read-only mode.');
        const mode = oneOf(input.mode, ['soft', 'mixed', 'hard', 'keep'], 'mixed');
        const reset = await sbWorkspaceGitReset(target, {
          id: ref.id,
          mode,
          ...(str(input.target) ? { target: str(input.target) } : {}),
          ...(strings(input.paths).length ? { paths: strings(input.paths) } : {}),
        });
        if (!reset.ok) return failed(reset.err);
        return textResult(
          `${strings(input.paths).length ? 'Unstaged.' : `Reset (${mode}).`} ${reset.val.branch} is at ${reset.val.head}.` +
            (reset.val.output ? `\n${reset.val.output}` : '')
        );
      },
    },
    {
      def: {
        name: 'code_git_stash',
        description:
          'Set uncommitted work aside and bring it back. action "push" stashes the changes ' +
          '(message to name it, includeUntracked for new files, paths for some files only), ' +
          '"list" shows the stashes, "show" one stash’s diff, "pop" applies the stash and drops ' +
          'it, "apply" applies and keeps it, "drop" discards it; index names a stash by position ' +
          `(0 is the newest, at most ${STASH_MAX_INDEX}). A pop or apply that conflicts names the files and keeps the stash.`,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['push', 'list', 'show', 'pop', 'apply', 'drop'] },
            message: { type: 'string', maxLength: 200 },
            includeUntracked: { type: 'boolean' },
            paths: pathsProperty('With push: stash only these files.'),
            index: { type: 'integer', minimum: 0, maximum: STASH_MAX_INDEX },
          },
          required: ['action'],
        },
      },
      async execute(input, context) {
        const action = oneOf(
          input.action,
          ['push', 'list', 'show', 'pop', 'apply', 'drop'],
          'list'
        );
        if (action !== 'list' && action !== 'show' && context.readOnly) {
          return errorResult('The organization is in read-only mode.');
        }
        const stashed = await sbWorkspaceGitStash(target, {
          id: ref.id,
          action,
          ...(str(input.message) ? { message: str(input.message) } : {}),
          ...(input.includeUntracked === true ? { includeUntracked: true } : {}),
          ...(strings(input.paths).length ? { paths: strings(input.paths) } : {}),
          ...(num(input.index) !== undefined ? { index: num(input.index) } : {}),
          author: await authorFor(context),
        });
        if (!stashed.ok) return failed(stashed.err);
        const list = stashed.val.stashes.length
          ? stashed.val.stashes
              .map((stash) => `  ${stash.index}: ${stash.message} (${stash.date})`)
              .join('\n')
          : '  (none)';
        const conflicts = stashed.val.conflicts.length
          ? `\nCONFLICTS in: ${stashed.val.conflicts.join(', ')} — resolve them with the file tools; the stash is kept until you drop it.`
          : '';
        return textResult(
          `${action === 'list' ? '' : `${stashed.val.output || `Stash ${action} done.`}\n`}` +
            `Stashes on ${stashed.val.branch}:\n${list}${conflicts}`
        );
      },
    },
    {
      def: {
        name: 'code_git_clean',
        description:
          'Remove untracked files and folders from the checkout (build output, scratch files). ' +
          'Dry by default: without dryRun false it only lists what would go. ignored takes files ' +
          '.gitignore ignores too (node_modules, dist — a slow reinstall follows); paths limits it. ' +
          'Irreversible once run for real: list first, then say what will go.',
        inputSchema: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', description: 'false to remove; default true (list only).' },
            ignored: { type: 'boolean' },
            paths: pathsProperty('Only under these paths.'),
          },
        },
      },
      async execute(input, context) {
        const dryRun = input.dryRun !== false;
        if (!dryRun && context.readOnly)
          return errorResult('The organization is in read-only mode.');
        const cleaned = await sbWorkspaceGitClean(target, {
          id: ref.id,
          dryRun,
          ...(input.ignored === true ? { ignored: true } : {}),
          ...(strings(input.paths).length ? { paths: strings(input.paths) } : {}),
        });
        if (!cleaned.ok) return failed(cleaned.err);
        if (cleaned.val.paths.length === 0) return textResult('Nothing untracked to remove.');
        return textResult(
          `${cleaned.val.dryRun ? 'Would remove (pass dryRun false to remove)' : 'Removed'}:\n${cleaned.val.paths.map((path) => `  ${path}`).join('\n')}`
        );
      },
    },
    {
      def: {
        name: 'code_git_sparse_checkout',
        description:
          'Narrow the working tree of a large repository to the directories the task touches ' +
          '(a monorepo’s one app and the packages it uses), so searches, installs and builds see ' +
          'only those: action "set" keeps exactly paths (cone mode: each directory and its ' +
          'parents’ files), "add" keeps more, "list" shows what is kept, "disable" brings the ' +
          `whole tree back. History and git are whole either way; at most ${SPARSE_PATHS_MAX} paths.`,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'set', 'add', 'disable'] },
            paths: pathsProperty('Directories to keep, relative to the root.'),
          },
          required: ['action'],
        },
      },
      async execute(input, context) {
        const action = oneOf(input.action, ['list', 'set', 'add', 'disable'], 'list');
        if (action !== 'list' && context.readOnly) {
          return errorResult('The organization is in read-only mode.');
        }
        const sparse = await sbWorkspaceGitSparseCheckout(target, {
          id: ref.id,
          action,
          ...(strings(input.paths).length ? { paths: strings(input.paths) } : {}),
        });
        if (!sparse.ok) return failed(sparse.err);
        return textResult(
          sparse.val.enabled
            ? `Sparse checkout on; the working tree keeps:\n${sparse.val.patterns.map((pattern) => `  ${pattern}`).join('\n')}`
            : 'Sparse checkout is off: the working tree is the whole repository.'
        );
      },
    },
  ];
}
