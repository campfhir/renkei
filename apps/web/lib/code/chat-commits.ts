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
 * The transcript's word is the chat's own, not git's: a push from
 * another chat, or a commit the person made by hand, is not here. The
 * worker's `git-show` verb (`…/diff?commit=`) is what says where a commit
 * stands now — pushed by anyone, on the current branch or not — and the
 * panel asks it per commit.
 */

import type { ChatBlock, ChatMessageView } from '@/lib/chat/views';

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
    if (message.role !== 'assistant') continue;
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
