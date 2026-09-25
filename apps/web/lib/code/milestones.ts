/**
 * The calls a code project's chat makes that a person actually waits
 * for — a commit, a push, a pull request opened, merged or closed, a
 * branch made or removed. The thread folds a reply's tool calls into
 * one collapsed line so that ten file reads read as a line, not a wall;
 * these are the calls that must NOT disappear into that line. They are
 * lifted out of the fold as milestone cards, in order, with a sentence,
 * the headline the tool answered with, and the link it gave. Every other
 * exchange with the git host — reading a file, listing branches or
 * pipelines, a comment on a pull request — folds like any other tool
 * call; and outside a code project nothing is lifted at all (segment.ts
 * asks only there), a word to Bitbucket or GitHub being a tool call like
 * any other. Pure; the icons and the cards live in message-list.tsx.
 */

import { friendlyToolName } from '@/lib/tool-name';

/** A milestone changes the repository's history or its host: there is no other kind. */
export type MilestoneKind = 'act';

export type MilestoneState = 'pending' | 'done' | 'failed' | 'waiting';

interface Sentences {
  pending: string;
  done: string;
  failed: string;
}

const SENTENCES: Record<string, Sentences> = {
  code_git_commit: { pending: 'Committing', done: 'Committed', failed: 'The commit failed' },
  code_git_push: {
    pending: 'Pushing to the remote',
    done: 'Pushed to the remote',
    failed: 'The push failed',
  },
  code_git_pull: {
    pending: 'Pulling from the remote',
    done: 'Pulled from the remote',
    failed: 'The pull failed',
  },
  bitbucket_create_pull_request: {
    pending: 'Opening a pull request',
    done: 'Opened a pull request',
    failed: 'The pull request could not be opened',
  },
  bitbucket_update_pull_request: {
    pending: 'Updating the pull request',
    done: 'Updated the pull request',
    failed: 'The pull request could not be updated',
  },
  bitbucket_merge_pull_request: {
    pending: 'Merging the pull request',
    done: 'Merged the pull request',
    failed: 'The merge failed',
  },
  bitbucket_approve_pull_request: {
    pending: 'Approving the pull request',
    done: 'Approved the pull request',
    failed: 'The approval failed',
  },
  bitbucket_decline_pull_request: {
    pending: 'Declining the pull request',
    done: 'Declined the pull request',
    failed: 'The pull request could not be declined',
  },
  bitbucket_request_pr_changes: {
    pending: 'Requesting changes on the pull request',
    done: 'Requested changes on the pull request',
    failed: 'Changes could not be requested',
  },
  bitbucket_add_pr_comment: {
    pending: 'Commenting on the pull request',
    done: 'Commented on the pull request',
    failed: 'The comment could not be added',
  },
  bitbucket_add_pr_task: {
    pending: 'Adding a pull request task',
    done: 'Added a pull request task',
    failed: 'The task could not be added',
  },
  bitbucket_resolve_pr_comment: {
    pending: 'Resolving a pull request comment',
    done: 'Resolved a pull request comment',
    failed: 'The comment could not be resolved',
  },
  bitbucket_create_branch: {
    pending: 'Creating a branch on Bitbucket',
    done: 'Created a branch on Bitbucket',
    failed: 'The branch could not be created',
  },
  bitbucket_delete_branch: {
    pending: 'Deleting a branch on Bitbucket',
    done: 'Deleted a branch on Bitbucket',
    failed: 'The branch could not be deleted',
  },
  bitbucket_commit_file: {
    pending: 'Committing a file on Bitbucket',
    done: 'Committed a file on Bitbucket',
    failed: 'The commit failed',
  },
  bitbucket_commit_files: {
    pending: 'Committing files on Bitbucket',
    done: 'Committed files on Bitbucket',
    failed: 'The commit failed',
  },
  bitbucket_trigger_pipeline: {
    pending: 'Starting a pipeline',
    done: 'Started a pipeline',
    failed: 'The pipeline could not be started',
  },
  bitbucket_stop_pipeline: {
    pending: 'Stopping a pipeline',
    done: 'Stopped a pipeline',
    failed: 'The pipeline could not be stopped',
  },
  bitbucket_get_pull_request: {
    pending: 'Reading the pull request',
    done: 'Read the pull request',
    failed: 'The pull request could not be read',
  },
  bitbucket_list_pull_requests: {
    pending: 'Listing pull requests',
    done: 'Listed pull requests',
    failed: 'Pull requests could not be listed',
  },
  bitbucket_get_pull_request_diff: {
    pending: 'Reading the pull request’s diff',
    done: 'Read the pull request’s diff',
    failed: 'The diff could not be read',
  },
  bitbucket_list_pr_comments: {
    pending: 'Reading pull request comments',
    done: 'Read pull request comments',
    failed: 'The comments could not be read',
  },
  bitbucket_list_pr_tasks: {
    pending: 'Reading pull request tasks',
    done: 'Read pull request tasks',
    failed: 'The tasks could not be read',
  },
  bitbucket_get_pipeline: {
    pending: 'Checking the pipeline',
    done: 'Checked the pipeline',
    failed: 'The pipeline could not be read',
  },
  bitbucket_list_pipelines: {
    pending: 'Listing pipelines',
    done: 'Listed pipelines',
    failed: 'Pipelines could not be listed',
  },
  bitbucket_get_pipeline_step_log: {
    pending: 'Reading a pipeline log',
    done: 'Read a pipeline log',
    failed: 'The log could not be read',
  },
  bitbucket_list_commits: {
    pending: 'Listing commits on Bitbucket',
    done: 'Listed commits on Bitbucket',
    failed: 'Commits could not be listed',
  },
  bitbucket_get_commit: {
    pending: 'Reading a commit on Bitbucket',
    done: 'Read a commit on Bitbucket',
    failed: 'The commit could not be read',
  },
  bitbucket_get_diff: {
    pending: 'Reading a diff on Bitbucket',
    done: 'Read a diff on Bitbucket',
    failed: 'The diff could not be read',
  },
  bitbucket_list_branches: {
    pending: 'Listing branches on Bitbucket',
    done: 'Listed branches on Bitbucket',
    failed: 'Branches could not be listed',
  },
  bitbucket_search_code: {
    pending: 'Searching code on Bitbucket',
    done: 'Searched code on Bitbucket',
    failed: 'The search failed',
  },
  github_create_pull_request: {
    pending: 'Opening a pull request',
    done: 'Opened a pull request',
    failed: 'The pull request could not be opened',
  },
  github_update_pull_request: {
    pending: 'Updating the pull request',
    done: 'Updated the pull request',
    failed: 'The pull request could not be updated',
  },
  github_merge_pull_request: {
    pending: 'Merging the pull request',
    done: 'Merged the pull request',
    failed: 'The merge failed',
  },
  github_approve_pull_request: {
    pending: 'Approving the pull request',
    done: 'Approved the pull request',
    failed: 'The approval failed',
  },
  github_close_pull_request: {
    pending: 'Closing the pull request',
    done: 'Closed the pull request',
    failed: 'The pull request could not be closed',
  },
  github_request_pr_changes: {
    pending: 'Requesting changes on the pull request',
    done: 'Requested changes on the pull request',
    failed: 'Changes could not be requested',
  },
  github_add_pr_comment: {
    pending: 'Commenting on the pull request',
    done: 'Commented on the pull request',
    failed: 'The comment could not be added',
  },
  github_resolve_pr_comment: {
    pending: 'Resolving a pull request review thread',
    done: 'Resolved a pull request review thread',
    failed: 'The thread could not be resolved',
  },
  github_create_branch: {
    pending: 'Creating a branch on GitHub',
    done: 'Created a branch on GitHub',
    failed: 'The branch could not be created',
  },
  github_delete_branch: {
    pending: 'Deleting a branch on GitHub',
    done: 'Deleted a branch on GitHub',
    failed: 'The branch could not be deleted',
  },
  github_commit_file: {
    pending: 'Committing a file on GitHub',
    done: 'Committed a file on GitHub',
    failed: 'The commit failed',
  },
  github_commit_files: {
    pending: 'Committing files on GitHub',
    done: 'Committed files on GitHub',
    failed: 'The commit failed',
  },
  github_trigger_workflow: {
    pending: 'Starting a workflow run',
    done: 'Started a workflow run',
    failed: 'The workflow run could not be started',
  },
  github_cancel_workflow_run: {
    pending: 'Cancelling a workflow run',
    done: 'Cancelled a workflow run',
    failed: 'The workflow run could not be cancelled',
  },
  github_get_pull_request: {
    pending: 'Reading the pull request',
    done: 'Read the pull request',
    failed: 'The pull request could not be read',
  },
  github_list_pull_requests: {
    pending: 'Listing pull requests',
    done: 'Listed pull requests',
    failed: 'Pull requests could not be listed',
  },
  github_get_pull_request_diff: {
    pending: 'Reading the pull request’s diff',
    done: 'Read the pull request’s diff',
    failed: 'The diff could not be read',
  },
  github_list_pr_comments: {
    pending: 'Reading pull request comments',
    done: 'Read pull request comments',
    failed: 'The comments could not be read',
  },
  github_get_workflow_run: {
    pending: 'Checking the workflow run',
    done: 'Checked the workflow run',
    failed: 'The workflow run could not be read',
  },
  github_list_workflow_runs: {
    pending: 'Listing workflow runs',
    done: 'Listed workflow runs',
    failed: 'Workflow runs could not be listed',
  },
  github_get_workflow_job_log: {
    pending: 'Reading a workflow job’s log',
    done: 'Read a workflow job’s log',
    failed: 'The log could not be read',
  },
  github_list_commits: {
    pending: 'Listing commits on GitHub',
    done: 'Listed commits on GitHub',
    failed: 'Commits could not be listed',
  },
  github_get_commit: {
    pending: 'Reading a commit on GitHub',
    done: 'Read a commit on GitHub',
    failed: 'The commit could not be read',
  },
  github_get_diff: {
    pending: 'Reading a diff on GitHub',
    done: 'Read a diff on GitHub',
    failed: 'The diff could not be read',
  },
  github_list_branches: {
    pending: 'Listing branches on GitHub',
    done: 'Listed branches on GitHub',
    failed: 'Branches could not be listed',
  },
  github_search_code: {
    pending: 'Searching code on GitHub',
    done: 'Searched code on GitHub',
    failed: 'The search failed',
  },
};

/** The prefixes of the git-host tool families whose acts are milestones. */
const HOST_TOOL_PREFIXES = ['bitbucket_', 'github_'];

/**
 * The git-host verbs a person waits on: a pull request opened, changed,
 * approved, merged, declined or closed; a commit; a branch made or
 * removed. Reads (a file, a diff, a list of branches or pipelines) and
 * the quieter acts (a comment, a task, a pipeline run, a permission
 * grant) are ordinary tool calls and fold with the rest.
 */
const MILESTONE_ACTIONS = new Set([
  'create_pull_request',
  'update_pull_request',
  'merge_pull_request',
  'approve_pull_request',
  'decline_pull_request',
  'close_pull_request',
  'request_pr_changes',
  'commit_file',
  'commit_files',
  'create_branch',
  'delete_branch',
]);

/** A `_preview` or `_confirm` variant reads as its plain tool. */
function baseName(name: string): string {
  return name.replace(/_(preview|confirm)$/, '');
}

/**
 * Whether this call is a milestone: the chat's own git verbs that reach
 * the repository's history or its host, and the `bitbucket_*`/`github_*`
 * acts on pull requests, commits and branches. Everything else — every
 * read, and the host's other acts — is null, and folds.
 */
export function milestoneKindOf(name: string): MilestoneKind | null {
  const base = baseName(name);
  if (base === 'code_git_commit' || base === 'code_git_push' || base === 'code_git_pull') {
    return 'act';
  }
  const prefix = HOST_TOOL_PREFIXES.find((candidate) => base.startsWith(candidate));
  if (!prefix) return null;
  return MILESTONE_ACTIONS.has(base.slice(prefix.length)) ? 'act' : null;
}

/** The card's own line for a call in this state. */
export function milestoneSentence(name: string, state: MilestoneState): string {
  const own = SENTENCES[baseName(name)];
  const label = friendlyToolName(name, null);
  switch (state) {
    case 'pending':
      return own?.pending ?? `Calling ${label}`;
    case 'done':
      return own?.done ?? `Called ${label}`;
    case 'failed':
      return own?.failed ?? `${label} failed`;
    case 'waiting':
      return `Waiting for permission: ${own?.pending.toLowerCase() ?? label}`;
  }
}

export interface MilestoneLink {
  label: string;
  url: string;
}

export interface MilestoneSummary {
  /** The result's first line, links flattened to their labels; null when it would not read as one. */
  headline: string | null;
  /** The first Markdown link in the result that points somewhere over https. */
  link: MilestoneLink | null;
}

const HEADLINE_MAX_CHARS = 160;
const MARKDOWN_LINK = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;

/**
 * What the tool said, in one line — "Committed on feat/x: 1a2b3c4 Fix
 * the timeout", "Created pull request #12: Fix the timeout" — and the
 * link it gave. Nothing here guesses at identifiers: it is the tool's
 * own first line and the tool's own link, or nothing.
 */
export function milestoneSummary(resultText: string): MilestoneSummary {
  const links: MilestoneLink[] = [];
  for (const match of resultText.matchAll(MARKDOWN_LINK)) {
    links.push({ label: match[1] ?? 'Open', url: match[2] ?? '' });
  }
  const first = resultText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  let headline: string | null = null;
  if (first) {
    const flat = first.replace(MARKDOWN_LINK, '$1').trim();
    // A line that is a document rather than a sentence (JSON, a table
    // row) has no business as a headline; the details hold it in full.
    if (flat && !/^[{[|]/.test(flat) && !flat.startsWith('```')) {
      headline =
        flat.length > HEADLINE_MAX_CHARS ? `${flat.slice(0, HEADLINE_MAX_CHARS - 1)}…` : flat;
    }
  }
  return { headline, link: links[0] ?? null };
}
