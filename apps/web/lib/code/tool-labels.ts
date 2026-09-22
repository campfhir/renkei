/**
 * How the code tools read in a chat's transcript: a plain name for each,
 * and for the clone step — the runner's own, not the model's — the
 * sentence forms a person expects ("Cloning the repository…", "Cloned
 * the repository"). Anything unnamed here falls back to the generic
 * tool naming. Pure; the icons live with the components.
 */

export interface CodeToolLabel {
  /** The name shown after "Called" / "Calling". */
  label: string;
  /** Full lines for the running, finished and failed states, when the tool reads better as a sentence. */
  pending?: string;
  done?: string;
  failed?: string;
}

const LABELS: Record<string, CodeToolLabel> = {
  code_clone: {
    label: 'Clone repository',
    pending: 'Cloning the repository',
    done: 'Cloned the repository',
    failed: 'The clone failed',
  },
  code_git_commit: { label: 'Commit' },
  code_git_push: { label: 'Push' },
  code_git_pull: { label: 'Pull' },
  code_git_status: { label: 'Git status' },
  code_run: { label: 'Run command' },
  code_edit_file: { label: 'Edit file' },
  code_write_file: { label: 'Write file' },
  code_read_file: { label: 'Read file' },
  code_grep: { label: 'Search code' },
  code_find: { label: 'Find files' },
  code_ls: { label: 'List directory' },
  code_env_names: { label: 'Environment names' },
  code_delegate: { label: 'Sub-agent' },
  bitbucket_create_pull_request: { label: 'Open pull request' },
  bitbucket_create_pull_request_preview: { label: 'Open pull request' },
  bitbucket_create_pull_request_confirm: { label: 'Open pull request' },
  bitbucket_merge_pull_request: { label: 'Merge pull request' },
  github_create_pull_request: { label: 'Open pull request' },
  github_create_pull_request_preview: { label: 'Open pull request' },
  github_create_pull_request_confirm: { label: 'Open pull request' },
  github_merge_pull_request: { label: 'Merge pull request' },
};

export function codeToolLabel(name: string): CodeToolLabel | null {
  return LABELS[name] ?? null;
}

/** Which git glyph a tool call gets, by what its name says it does; null for anything else. */
export function gitGlyphFor(
  name: string
):
  | 'clone'
  | 'commit'
  | 'push'
  | 'pull'
  | 'branch'
  | 'checkout'
  | 'merge'
  | 'rebase'
  | 'stash'
  | 'pullRequest'
  | null {
  if (name === 'code_clone' || name.includes('clone')) return 'clone';
  if (name.includes('pull_request') || name.includes('pullrequest')) {
    return name.includes('merge') ? 'merge' : 'pullRequest';
  }
  if (name.includes('commit')) return 'commit';
  if (name.includes('push')) return 'push';
  if (name.includes('pull')) return 'pull';
  if (name.includes('merge')) return 'merge';
  if (name.includes('rebase')) return 'rebase';
  if (name.includes('stash')) return 'stash';
  if (name.includes('checkout')) return 'checkout';
  if (name.includes('branch') || name === 'code_git_status') return 'branch';
  return null;
}
