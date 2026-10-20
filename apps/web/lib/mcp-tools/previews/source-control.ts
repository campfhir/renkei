/**
 * Preview cards for the two git hosts. Bitbucket and GitHub name the same
 * things differently (workspace/repoSlug/id against owner/repo/number), so
 * each builder reads either shape and says which host it is in the card —
 * the cards themselves are the same for both. (Opening, merging and
 * triggering have hand-written cards next to their tools.)
 */

import type { FileChange } from '@/lib/mcp-widgets/src/act-card';
import type { PreviewBuilder, PreviewSpec } from './card';
import { clip, records, ref, strings, text, yes } from './card';

type Args = Record<string, unknown>;

interface Host {
  name: 'Bitbucket' | 'GitHub';
  repo: string;
  pr: string;
}

function hostOf(args: Args): Host {
  const github = 'owner' in args;
  const repo = github
    ? `${text(args.owner)}/${text(args.repo)}`
    : `${text(args.workspace)}/${text(args.repoSlug)}`;
  return { name: github ? 'GitHub' : 'Bitbucket', repo, pr: text(args.number ?? args.id) };
}

const prRef = (host: Host) => ref(`#${host.pr}`, 'Pull request', host.repo);

function addComment(args: Args): PreviewSpec {
  const host = hostOf(args);
  const reply = args.parentId !== undefined;
  const file = text(args.path);
  return {
    verb: reply ? 'Reply' : 'Comment',
    icon: 'comment',
    title: file ? `Comment on ${file} in #${host.pr}` : `Comment on pull request #${host.pr}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: 'Post comment',
    editable: [{ key: 'comment', label: 'Comment', multiline: true }],
    body: {
      kind: 'comment',
      mode: 'add',
      on: prRef(host),
      bodyKey: 'comment',
      body: text(args.comment),
      badges: [file ? 'Inline' : 'General', ...(reply ? ['Reply'] : [])],
      ...(file
        ? { anchor: { file, ...(typeof args.line === 'number' ? { line: args.line } : {}) } }
        : {}),
    },
  };
}

function resolveComment(args: Args): PreviewSpec {
  const host = hostOf(args);
  const reopen = yes(args.reopen);
  return {
    verb: reopen ? 'Reopen' : 'Resolve',
    icon: 'check',
    title: `${reopen ? 'Reopen' : 'Resolve'} a comment thread on #${host.pr}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: reopen ? 'Reopen thread' : 'Resolve thread',
    body: {
      kind: 'comment',
      mode: reopen ? 'reopen' : 'resolve',
      on: prRef(host),
      commentId: text(args.commentId),
    },
  };
}

function update(args: Args): PreviewSpec {
  const host = hostOf(args);
  const reviewers = strings(args.reviewers);
  return {
    verb: 'Update',
    icon: 'merge',
    title: `Update pull request #${host.pr}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: 'Update pull request',
    body: {
      kind: 'change',
      subject: prRef(host),
      rows: [
        ...(text(args.title) ? [{ label: 'Title', value: text(args.title) }] : []),
        ...(text(args.description)
          ? [{ label: 'Description', value: clip(text(args.description), 1200), block: true }]
          : []),
        ...(text(args.destinationBranch)
          ? [{ label: 'Merges into', value: text(args.destinationBranch) }]
          : []),
        ...(reviewers.length > 0 ? [{ label: 'Reviewers', value: reviewers.join(', ') }] : []),
      ],
      notes: ['Only what is shown changes.'],
    },
  };
}

const LINES_PEEK = 14;

function lineCount(content: string): number {
  return content === '' ? 0 : content.split('\n').length;
}

function commitOne(args: Args): PreviewSpec {
  const host = hostOf(args);
  const content = String(args.content ?? '');
  const path = text(args.path).replace(/^\/+/, '');
  const lines = content.split('\n');
  const file: FileChange = {
    path,
    status: 'modify',
    lines: lineCount(content),
    peek:
      clip(lines.slice(0, LINES_PEEK).join('\n'), 1200) + (lines.length > LINES_PEEK ? '\n…' : ''),
  };
  return {
    verb: 'Commit',
    icon: 'commit',
    title: `Commit ${path} to ${text(args.branch)}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: 'Commit file',
    editable: [{ key: 'message', label: 'Commit message', multiline: false }],
    body: {
      kind: 'commit',
      repo: host.repo,
      branch: text(args.branch),
      messageKey: 'message',
      message: text(args.message),
      files: [file],
    },
  };
}

const MAX_FILES = 40;

function commitMany(args: Args): PreviewSpec {
  const host = hostOf(args);
  const written: FileChange[] = records(args.files).map((entry) => ({
    path: text(entry.path).replace(/^\/+/, ''),
    status: 'modify',
    lines: lineCount(String(entry.content ?? '')),
  }));
  const removed: FileChange[] = strings(args.delete).map((path) => ({
    path: path.replace(/^\/+/, ''),
    status: 'delete',
  }));
  const all = [...written, ...removed];
  const shown = all.slice(0, MAX_FILES);
  return {
    verb: 'Commit',
    icon: 'commit',
    title: `Commit ${all.length} file${all.length === 1 ? '' : 's'} to ${text(args.branch)}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: 'Commit files',
    editable: [{ key: 'message', label: 'Commit message', multiline: false }],
    body: {
      kind: 'commit',
      repo: host.repo,
      branch: text(args.branch),
      messageKey: 'message',
      message: text(args.message),
      files: shown,
      ...(all.length > shown.length ? { omitted: all.length - shown.length } : {}),
    },
  };
}

function createBranch(args: Args): PreviewSpec {
  const host = hostOf(args);
  return {
    verb: 'Create',
    icon: 'branch',
    title: `Create the branch ${text(args.name)}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: 'Create branch',
    body: {
      kind: 'branch',
      mode: 'create',
      repo: host.repo,
      name: text(args.name),
      base: text(args.target),
    },
  };
}

function deleteBranch(args: Args): PreviewSpec {
  const host = hostOf(args);
  return {
    verb: 'Delete',
    tone: 'danger',
    icon: 'branch',
    title: `Delete the branch ${text(args.name)}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: 'Delete branch',
    body: { kind: 'branch', mode: 'delete', repo: host.repo, name: text(args.name) },
  };
}

function grant(args: Args): PreviewSpec {
  const host = hostOf(args);
  const group = text(args.group);
  const who = text(args.userId) || text(args.username) || group;
  return {
    verb: 'Grant',
    tone: 'caution',
    icon: 'users',
    title: `Give ${who} ${text(args.permission)} access to ${host.repo}`,
    subtitle: host.name,
    confirmLabel: 'Grant access',
    body: {
      kind: 'access',
      mode: 'grant',
      who: [{ name: who, kind: group ? 'group' : 'user' }],
      level: text(args.permission),
      on: ref(host.repo, 'Repository'),
    },
  };
}

function revoke(args: Args): PreviewSpec {
  const host = hostOf(args);
  const group = text(args.group);
  const who = text(args.userId) || text(args.username) || group;
  return {
    verb: 'Revoke',
    tone: 'danger',
    icon: 'users',
    title: `Take ${who}’s access to ${host.repo} away`,
    subtitle: host.name,
    confirmLabel: 'Revoke access',
    body: {
      kind: 'access',
      mode: 'revoke',
      who: [{ name: who, kind: group ? 'group' : 'user' }],
      on: ref(host.repo, 'Repository'),
    },
  };
}

const approve = (args: Args): PreviewSpec => {
  const host = hostOf(args);
  const withdraw = yes(args.revoke);
  return {
    verb: withdraw ? 'Withdraw' : 'Approve',
    tone: withdraw ? 'caution' : 'positive',
    icon: 'check',
    title: withdraw ? `Withdraw your approval of #${host.pr}` : `Approve pull request #${host.pr}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: withdraw ? 'Withdraw approval' : 'Approve',
    editable:
      args.comment === undefined ? [] : [{ key: 'comment', label: 'Comment', multiline: true }],
    body: {
      kind: 'verdict',
      verdict: withdraw ? 'unapprove' : 'approve',
      pullRequest: prRef(host),
      bodyKey: 'comment',
      body: text(args.comment),
    },
  };
};

const requestChanges = (args: Args): PreviewSpec => {
  const host = hostOf(args);
  const withdraw = yes(args.revoke);
  return {
    verb: withdraw ? 'Withdraw' : 'Request changes',
    tone: 'caution',
    icon: 'flag',
    title: withdraw
      ? `Withdraw your change request on #${host.pr}`
      : `Request changes on pull request #${host.pr}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: withdraw ? 'Withdraw request' : 'Request changes',
    editable:
      args.comment === undefined
        ? []
        : [{ key: 'comment', label: 'What needs to change', multiline: true }],
    body: {
      kind: 'verdict',
      verdict: withdraw ? 'unchange' : 'changes',
      pullRequest: prRef(host),
      bodyKey: 'comment',
      body: text(args.comment),
    },
  };
};

const decline =
  (verdict: 'decline' | 'close') =>
  (args: Args): PreviewSpec => {
    const host = hostOf(args);
    return {
      verb: verdict === 'decline' ? 'Decline' : 'Close',
      tone: 'danger',
      icon: 'cross',
      title: `${verdict === 'decline' ? 'Decline' : 'Close'} pull request #${host.pr}`,
      subtitle: `${host.name} · ${host.repo}`,
      confirmLabel: verdict === 'decline' ? 'Decline pull request' : 'Close pull request',
      body: { kind: 'verdict', verdict, pullRequest: prRef(host) },
    };
  };

function project(mode: 'create' | 'update' | 'delete') {
  return (args: Args): PreviewSpec => {
    const key = text(args.key) || text(args.projectKey);
    const rows = [
      ...(mode === 'update' && text(args.name) ? [{ label: 'Name', value: text(args.name) }] : []),
      ...(mode === 'create' && text(args.name) ? [{ label: 'Name', value: text(args.name) }] : []),
      ...(mode === 'update' && text(args.newKey)
        ? [{ label: 'Key', from: key, value: text(args.newKey) }]
        : []),
      ...(text(args.description) ? [{ label: 'Description', value: text(args.description) }] : []),
      ...(args.isPrivate === undefined
        ? []
        : [
            {
              label: 'Visibility',
              value: yes(args.isPrivate) ? 'Private' : 'Visible to the workspace',
            },
          ]),
    ];
    return {
      verb: mode === 'create' ? 'Create' : mode === 'update' ? 'Update' : 'Delete',
      tone: mode === 'delete' ? 'danger' : 'neutral',
      icon: mode === 'delete' ? 'trash' : 'folder',
      title:
        mode === 'create'
          ? `Create the project ${text(args.name)}`
          : mode === 'update'
            ? `Update the project ${key}`
            : `Delete the project ${key}`,
      subtitle: `Bitbucket · ${text(args.workspace)}`,
      confirmLabel:
        mode === 'create'
          ? 'Create project'
          : mode === 'update'
            ? 'Update project'
            : 'Delete project',
      body: {
        kind: 'change',
        subject: ref(key, 'Project', text(args.workspace)),
        rows,
        notes:
          mode === 'delete' ? ['A project can only be deleted once it has no repositories.'] : [],
      },
    };
  };
}

const stop = (args: Args): PreviewSpec => {
  const host = hostOf(args);
  const github = host.name === 'GitHub';
  return {
    verb: github ? 'Cancel run' : 'Stop',
    tone: 'caution',
    icon: 'stop',
    title: github
      ? `Cancel workflow run ${text(args.runId)}`
      : `Stop pipeline ${text(args.pipelineUuid)}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: github ? 'Cancel run' : 'Stop pipeline',
    body: {
      kind: 'pipeline',
      mode: github ? 'cancel' : 'stop',
      repo: host.repo,
      run: github ? `Run ${text(args.runId)}` : text(args.pipelineUuid),
    },
  };
};

const task = (args: Args): PreviewSpec => {
  const host = hostOf(args);
  return {
    verb: 'Add task',
    icon: 'check',
    title: `Add a task to pull request #${host.pr}`,
    subtitle: `${host.name} · ${host.repo}`,
    confirmLabel: 'Add task',
    editable: [{ key: 'task', label: 'Task', multiline: true }],
    body: {
      kind: 'comment',
      mode: 'task',
      on: prRef(host),
      bodyKey: 'task',
      body: text(args.task),
    },
  };
};

export const SOURCE_CONTROL_PREVIEWS: Record<string, PreviewBuilder> = {
  bitbucket_add_pr_comment: addComment,
  github_add_pr_comment: addComment,
  bitbucket_add_pr_task: task,
  bitbucket_resolve_pr_comment: resolveComment,
  github_resolve_pr_comment: resolveComment,
  bitbucket_update_pull_request: update,
  github_update_pull_request: update,
  bitbucket_approve_pull_request: approve,
  github_approve_pull_request: approve,
  bitbucket_request_pr_changes: requestChanges,
  github_request_pr_changes: requestChanges,
  bitbucket_decline_pull_request: decline('decline'),
  github_close_pull_request: decline('close'),
  bitbucket_commit_file: commitOne,
  github_commit_file: commitOne,
  bitbucket_commit_files: commitMany,
  github_commit_files: commitMany,
  bitbucket_create_branch: createBranch,
  github_create_branch: createBranch,
  bitbucket_delete_branch: deleteBranch,
  github_delete_branch: deleteBranch,
  bitbucket_grant_repository_permission: grant,
  github_grant_repository_permission: grant,
  bitbucket_revoke_repository_permission: revoke,
  github_revoke_repository_permission: revoke,
  bitbucket_create_project: project('create'),
  bitbucket_update_project: project('update'),
  bitbucket_delete_project: project('delete'),
  bitbucket_stop_pipeline: stop,
  github_cancel_workflow_run: stop,
};
