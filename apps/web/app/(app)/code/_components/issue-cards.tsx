'use client';

/**
 * Small cards for the Jira issue and/or GitHub issue guessed from the
 * active chat's most recent pull request (…/chats/[chatId]/issues,
 * lib/code/issue-refs.ts's detectIssueRefs) — a Jira key or a GitHub
 * issue number read out of the PR's title, then fetched live with the
 * signed-in person's own grant on each connector. Renders nothing at
 * all when neither resolves: no token, an API failure, or simply no
 * reference found are all the same "say nothing" case here, not an
 * error state to show. What an answer shows is issue-cards.model.ts.
 */

import { useEffect, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import ExternalLink from '@/components/external-link';
import { getJson } from '@/lib/fetch-json';
import Pill from './pill';
import { cardLine, issueCardsOf, type IssueCard } from './issue-cards.model';

function Card({ icon, card }: { icon: string; card: IssueCard }) {
  return (
    <ExternalLink
      href={card.url}
      className="flex min-w-0 items-center gap-2 rounded-md border border-gray-200 px-2.5 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
    >
      <Icon path={icon} className="h-4 w-4 shrink-0 text-gray-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{cardLine(card)}</span>
      </span>
      {card.sub ? <Pill tone="gray">{card.sub}</Pill> : null}
    </ExternalLink>
  );
}

export default function IssueCards({ projectId, chatId }: { projectId: string; chatId: string }) {
  const [cards, setCards] = useState<IssueCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<unknown>(
        `/api/code/projects/${projectId}/chats/${chatId}/issues`
      );
      if (!cancelled && result.data) setCards(issueCardsOf(result.data));
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, chatId]);

  if (cards.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {cards.map((card) => (
        <Card key={card.label} icon={ICONS.approval} card={card} />
      ))}
    </div>
  );
}
