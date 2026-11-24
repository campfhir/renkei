'use client';

/**
 * An empty chat's word about agents (agent-mention.model.ts's
 * emptyChatAgents): the person's agents by name — the project's team
 * first — each a button that addresses the first message to it, so
 * "hand this to the agent that knows the area" is in front of them
 * before they type. Someone with no agents is pointed at making one.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import type { AskableAgent } from '@/lib/chat/agent-ask-view';
import { emptyChatAgents } from './agent-mention.model';

export default function AgentsHint({
  projectId,
  onAsk,
}: {
  projectId: string | null;
  onAsk: (agent: AskableAgent) => void;
}) {
  const [agents, setAgents] = useState<AskableAgent[] | null>(null);
  useEffect(() => {
    let live = true;
    void chatClient.askableAgents(projectId).then((result) => {
      if (live) setAgents(result.data?.agents ?? []);
    });
    return () => {
      live = false;
    };
  }, [projectId]);
  const hint = emptyChatAgents(agents);
  if (hint.kind === 'loading') return null;
  if (hint.kind === 'none') {
    return (
      <p className="mt-4 text-xs" data-agents-hint="none">
        Have work that runs on its own — triaging a queue, checking access, chasing tickets?{' '}
        <Link href="/agents/new" className="text-indigo-600 hover:underline dark:text-indigo-400">
          Make an agent
        </Link>{' '}
        and you can hand it tasks from any chat.
      </p>
    );
  }
  return (
    <div className="mt-6 text-left" data-agents-hint="some">
      <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
        Or hand a task to one of your agents
      </p>
      <p className="mt-0.5 text-xs">
        Like messaging a colleague who knows the area: it works in the background with its own
        tools and replies here. Type @ to pick one.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {hint.shown.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => onAsk(agent)}
            title={agent.description ?? undefined}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-indigo-200 bg-white px-2.5 py-1 text-xs font-medium text-indigo-800 hover:bg-indigo-50 dark:border-indigo-800 dark:bg-gray-900 dark:text-indigo-200 dark:hover:bg-indigo-950/50"
          >
            <Icon path={ICONS.agent} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Ask {agent.name}</span>
          </button>
        ))}
        {hint.more > 0 ? (
          <span className="self-center text-xs text-gray-400">+{hint.more} more with @</span>
        ) : null}
      </div>
    </div>
  );
}
