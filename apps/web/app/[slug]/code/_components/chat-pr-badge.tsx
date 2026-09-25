'use client';

/**
 * A small pill on a project's chat row: the chat's most recent pull
 * request (lib/code/chat-commits.ts's latestPrInTranscript, read
 * through …/chat/chats/[chatId]/pr-summary), or nothing when the chat
 * never touched one. Fetched per row rather than carried in the
 * project's own initial data, since it means reading that chat's own
 * transcript — capped by the caller to the rows actually worth asking
 * (the active chat plus the most recent previous ones), not every
 * history chat a project has ever had.
 */

import { useEffect, useState } from 'react';
import { getJson } from '@/lib/fetch-json';

interface ChatPullRequest {
  number: number;
  state: 'open' | 'merged';
  host: 'github' | 'bitbucket';
}

export default function ChatPrBadge({ tenantId, chatId }: { tenantId: string; chatId: string }) {
  const [pullRequest, setPullRequest] = useState<ChatPullRequest | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<{ pullRequest: ChatPullRequest | null }>(
        `/api/tenant/${tenantId}/chat/chats/${chatId}/pr-summary`
      );
      if (!cancelled && result.data) setPullRequest(result.data.pullRequest);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, chatId]);

  if (!pullRequest) return null;
  const tone =
    pullRequest.state === 'merged'
      ? 'bg-purple-100 text-purple-800 dark:bg-purple-950/50 dark:text-purple-300'
      : 'bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300';
  return (
    <span
      data-testid="chat-pr-badge"
      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
      title={`Pull request #${pullRequest.number} — ${pullRequest.state}`}
    >
      #{pullRequest.number}
    </span>
  );
}
