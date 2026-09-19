/**
 * The calls a code chat makes that a person actually waits for — a
 * commit, a push, a pull request opened or merged, a pipeline started,
 * a branch made — and, more quietly, every other exchange with
 * Bitbucket. The thread folds a reply's tool calls into one collapsed
 * line so that ten file reads read as a line, not a wall; these are the
 * calls that must NOT disappear into that line. They are lifted out of
 * the fold as milestone cards, in order, with a sentence, the headline
 * the tool answered with, and the link it gave. Pure; the icons and the
 * cards live in message-list.tsx.
 */

import { friendlyToolName } from '@/lib/tool-name';

/** An act changes something on Bitbucket or in git's history; a read only looks. */
export type MilestoneKind = 'act' | 'read';

export type MilestoneState = 'pending' | 'done' | 'failed' | 'waiting';

interface Sentences {
  pending: string;
  done: string;
  failed: string;
}

const SENTENCES: Record<string, Sentences> = {
  code_git_commit: { pending: 'Committing', done: 'Committed', failed: 'The commit failed' },
  code_git_push: {
    pending: 'Pushing to Bitbucket',
    done: 'Pushed to Bitbucket',
    failed: 'The push failed',
  },
  code_git_pull: {
    pending: 'Pulling from Bitbucket',
    done: 'Pulled from Bitbucket',
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
};

/** The verbs a Bitbucket tool's name carries when it changes something. */
const ACT_VERBS = new Set([
  'create',
  'update',
  'delete',
  'merge',
  'approve',
  'decline',
  'request',
  'add',
  'resolve',
  'trigger',
  'stop',
  'grant',
  'revoke',
  'commit',
]);

/** A `_preview` or `_confirm` variant reads as its plain tool. */
function baseName(name: string): string {
  return name.replace(/_(preview|confirm)$/, '');
}

/**
 * Whether this call is a milestone, and of which kind: the chat's own
 * git verbs that reach the repository's history or Bitbucket, and every
 * `bitbucket_*` tool — acts by their verb, the rest reads.
 */
export function milestoneKindOf(name: string): MilestoneKind | null {
  const base = baseName(name);
  if (base === 'code_git_commit' || base === 'code_git_push' || base === 'code_git_pull') {
    return 'act';
  }
  if (!base.startsWith('bitbucket_')) return null;
  const verb = base.slice('bitbucket_'.length).split('_')[0] ?? '';
  return ACT_VERBS.has(verb) ? 'act' : 'read';
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
