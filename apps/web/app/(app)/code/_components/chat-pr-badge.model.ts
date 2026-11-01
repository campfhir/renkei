/**
 * The badge on a project's chat row (chat-pr-badge.tsx): the chat's most
 * recent pull request, or nothing. What the pr-summary route answers is
 * narrowed here — anything that is not a pull request with a number and a
 * known state shows no badge rather than a wrong one — and the badge's
 * text, tone and title are decided here. Tested in
 * chat-pr-badge.model.test.ts.
 */

import { isRecord } from '@renkei/guards';

export interface ChatPullRequest {
  number: number;
  state: 'open' | 'merged';
}

/** The pull request a pr-summary answer names, or null for none (or an answer that is not one). */
export function chatPullRequestOf(answer: unknown): ChatPullRequest | null {
  if (!isRecord(answer) || !isRecord(answer.pullRequest)) return null;
  const { number, state } = answer.pullRequest;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
  if (state !== 'open' && state !== 'merged') return null;
  return { number, state };
}

/** The badge: `#42`, purple when merged and green while open, its state in the title. */
export function badgeOf(pullRequest: ChatPullRequest): {
  text: string;
  tone: 'purple' | 'green';
  title: string;
} {
  return {
    text: `#${pullRequest.number}`,
    tone: pullRequest.state === 'merged' ? 'purple' : 'green',
    title: `Pull request #${pullRequest.number} — ${pullRequest.state}`,
  };
}
