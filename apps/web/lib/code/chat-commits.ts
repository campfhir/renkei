/**
 * What a chat did to the repository, read off its own transcript: every
 * commit its code_git_commit calls made, in order, and whether a later
 * push in the same chat carried each one. No table records this — the
 * tool results already say "Committed on <branch>: <sha> <subject>" and
 * "Pushed <branch> to origin/<branch>", and the transcript is the one
 * record that survives everything but the chat's own deletion — so the
 * Changes panel and the milestone cards derive it here. Pure; the
 * browser runs it over the thread's messages as they stream.
 *
 * A commit or push the person made from the code pane counts too: the
 * pane writes a note row (lib/code/notes.ts) whose first line is the
 * tool's own sentence, so the same parsers read it.
 *
 * The transcript's word is this chat's own, not git's: a push from
 * another chat, or a commit made outside the app, is not here. The
 * worker's `git-show` verb (`…/diff?commit=`) is what says where a commit
 * stands now — pushed by anyone, on the current branch or not — and the
 * panel asks it per commit.
 */

import type { ChatBlock, ChatMessageView } from '@/lib/chat/views';
import { milestoneSummary } from './milestones';

export interface ChatCommit {
  /** The hash as the commit tool answered it — usually the short form. */
  sha: string;
  branch: string;
  subject: string;
  /** The tool_use id of the commit call, for finding it in the thread. */
  toolUseId: string;
  turnId: string | null;
  /** When the commit's row was written — close enough to the commit itself. */
  at: string;
  /** A push of this branch later in the chat carried the commit. */
  pushedInChat: boolean;
}

const COMMITTED = /^Committed on (\S+): ([0-9a-f]{4,40}) ?(.*)$/i;
const PUSHED = /^Pushed (\S+) to origin\/([^\s.]+(?:\.[^\s.]+)*)\.?$/i;

/** The `Committed on …` line of a commit tool's result, parsed; null for anything else. */
export function parseCommitResult(
  content: string
): { branch: string; sha: string; subject: string } | null {
  const first = content.split('\n').find((line) => line.trim() !== '') ?? '';
  const match = COMMITTED.exec(first.trim());
  if (!match) return null;
  return { branch: match[1] ?? '', sha: match[2] ?? '', subject: (match[3] ?? '').trim() };
}

/** The `Pushed … to origin/…` line of a push tool's result, parsed. */
export function parsePushResult(content: string): { branch: string; remoteBranch: string } | null {
  const first = content.split('\n').find((line) => line.trim() !== '') ?? '';
  const match = PUSHED.exec(first.trim());
  if (!match) return null;
  return { branch: match[1] ?? '', remoteBranch: match[2] ?? '' };
}

type ToolUse = Extract<ChatBlock, { type: 'tool_use' }>;
type ToolResult = Extract<ChatBlock, { type: 'tool_result' }>;

export type ChatPullRequestState = 'open' | 'merged';

export interface ChatPullRequest {
  number: number;
  /** Known from the create call's own result; null on a merge-only match. */
  title: string | null;
  state: ChatPullRequestState;
  host: 'github' | 'bitbucket';
  /** The tool's own "[Open on GitHub/Bitbucket]" link, when it gave one. */
  url: string | null;
  toolUseId: string;
  turnId: string | null;
  at: string;
}

const PR_CREATED = /^Created pull request #(\d+): (.*)$/;
const PR_MERGED = /^Merged pull request #(\d+)\b/;
const PR_TOOL_NAMES = new Set([
  'github_create_pull_request',
  'github_merge_pull_request',
  'bitbucket_create_pull_request',
  'bitbucket_merge_pull_request',
]);

/**
 * A pull-request create/merge tool's result, parsed the same way
 * parseCommitResult/parsePushResult read their own tools' first line —
 * plus the tool's own "[Open on GitHub/Bitbucket]" link
 * (milestones.ts's milestoneSummary already extracts it generically).
 */
function parsePrResult(
  toolName: string,
  content: string
): { number: number; title: string | null; state: ChatPullRequestState; url: string | null } | null {
  const first = content.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  const created = PR_CREATED.exec(first);
  const merged = created ? null : PR_MERGED.exec(first);
  const match = created ?? merged;
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  return {
    number,
    title: created ? (created[2] ?? '').trim() || null : null,
    state: created ? 'open' : 'merged',
    url: milestoneSummary(content).link?.url ?? null,
  };
}

/**
 * This chat's most recent pull request — the last create or merge call
 * to succeed, newest first, whichever PR it names. Chats can touch
 * several PRs over time; this is deliberately just the one to show
 * inline, not a full history (the project screen's Pulls page is that).
 */
export function latestPrInTranscript(messages: ChatMessageView[]): ChatPullRequest | null {
  const ordered = [...messages].sort((a, b) => b.seq - a.seq);
  const results = new Map<string, ToolResult>();
  for (const message of ordered) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') results.set(block.toolUseId, block);
    }
  }
  for (const message of ordered) {
    if (message.role !== 'assistant') continue;
    for (const block of [...message.blocks].reverse()) {
      if (block.type !== 'tool_use' || !PR_TOOL_NAMES.has(block.name)) continue;
      const use: ToolUse = block;
      const result = results.get(use.id);
      if (!result || result.isError) continue;
      const parsed = parsePrResult(use.name, result.content);
      if (!parsed) continue;
      return {
        ...parsed,
        host: use.name.startsWith('github_') ? 'github' : 'bitbucket',
        toolUseId: use.id,
        turnId: message.turnId,
        at: message.createdAt,
      };
    }
  }
  return null;
}

/**
 * The commits this chat made, oldest first. A commit counts once its
 * result arrived without error; a push of the same branch later in the
 * transcript marks every earlier commit on that branch as pushed here.
 */
export function commitsInTranscript(messages: ChatMessageView[]): ChatCommit[] {
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, ToolResult>();
  for (const message of ordered) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result') results.set(block.toolUseId, block);
    }
  }
  const commits: ChatCommit[] = [];
  for (const message of ordered) {
    if (message.role !== 'assistant') {
      if (message.kind !== 'note') continue;
      const text = message.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      const committed = parseCommitResult(text);
      if (committed) {
        commits.push({
          sha: committed.sha,
          branch: committed.branch,
          subject: committed.subject,
          toolUseId: message.id,
          turnId: message.turnId,
          at: message.createdAt,
          pushedInChat: false,
        });
        continue;
      }
      const pushed = parsePushResult(text);
      if (pushed) {
        for (const commit of commits) {
          if (commit.branch === pushed.branch) commit.pushedInChat = true;
        }
      }
      continue;
    }
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      const use: ToolUse = block;
      const result = results.get(use.id);
      if (!result || result.isError) continue;
      if (use.name === 'code_git_commit') {
        const parsed = parseCommitResult(result.content);
        if (!parsed) continue;
        commits.push({
          sha: parsed.sha,
          branch: parsed.branch,
          subject: parsed.subject,
          toolUseId: use.id,
          turnId: message.turnId,
          at: message.createdAt,
          pushedInChat: false,
        });
      } else if (use.name === 'code_git_push') {
        const parsed = parsePushResult(result.content);
        if (!parsed) continue;
        for (const commit of commits) {
          if (commit.branch === parsed.branch) commit.pushedInChat = true;
        }
      }
    }
  }
  return commits;
}
