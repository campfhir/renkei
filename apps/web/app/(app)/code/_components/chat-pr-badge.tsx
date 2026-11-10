'use client';

/**
 * A small pill on a project's chat row: the chat's most recent pull
 * request (lib/code/chat-commits.ts's latestPrInTranscript, read
 * through …/chat/chats/[chatId]/pr-summary), or nothing when the chat
 * never touched one. Fetched per row rather than carried in the
 * project's own initial data, since it means reading that chat's own
 * transcript — capped by the caller to the rows actually worth asking
 * (the most recent chats), not every chat a project has ever had. What
 * the answer shows is chat-pr-badge.model.ts.
 */

import { useEffect, useState } from 'react';
import { getJson } from '@/lib/fetch-json';
import { badgeOf, chatPullRequestOf, type ChatPullRequest } from './chat-pr-badge.model';

const TONES = {
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-950/50 dark:text-purple-300',
  green: 'bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300',
};

export default function ChatPrBadge({ chatId }: { chatId: string }) {
  const [pullRequest, setPullRequest] = useState<ChatPullRequest | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<unknown>(`/api/chat/chats/${chatId}/pr-summary`);
      if (!cancelled && result.data) setPullRequest(chatPullRequestOf(result.data));
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  if (!pullRequest) return null;
  const badge = badgeOf(pullRequest);
  return (
    <span
      data-testid="chat-pr-badge"
      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${TONES[badge.tone]}`}
      title={badge.title}
    >
      {badge.text}
    </span>
  );
}
