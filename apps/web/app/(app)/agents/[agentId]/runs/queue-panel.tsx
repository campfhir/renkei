import React from 'react';
import Link from 'next/link';
import type { QueueLine, QueuePanel as Panel } from './queue-panel.model';

/**
 * The runs page's Queue panel — what is holding an agent's work. What it
 * says is queue-panel.model.ts; this draws it. Open by itself when the
 * queue is not moving, folded when it is.
 */

const TONE: Record<Panel['verdict'], string> = {
  clear: 'border-gray-200 dark:border-gray-800',
  moving: 'border-gray-200 dark:border-gray-800',
  retrying: 'border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30',
  held: 'border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30',
  'not-picked-up': 'border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30',
};

function Line({ agentId, line }: { agentId: string; line: QueueLine }) {
  return (
    <li className="py-1">
      <span>{line.text}</span>{' '}
      {line.runId ? (
        <Link
          href={`/agents/${agentId}/runs/${line.runId}`}
          className="text-xs text-blue-700 hover:underline dark:text-blue-400"
        >
          Open run
        </Link>
      ) : null}
      {line.error ? (
        <span className="mt-0.5 block break-words font-mono text-xs text-red-700 dark:text-red-400">
          Last error: {line.error}
        </span>
      ) : null}
    </li>
  );
}

export default function QueuePanel({
  agentId,
  panel,
}: {
  agentId: string;
  panel: Panel;
}): React.ReactNode {
  if (!panel.visible) return null;
  const stalled = panel.verdict !== 'moving' && panel.verdict !== 'clear';
  return (
    <details
      open={stalled}
      className={`mb-3 rounded-lg border px-3 py-2 text-sm ${TONE[panel.verdict]}`}
    >
      <summary className="cursor-pointer font-medium">
        Queue
        <span className="ml-2 font-normal text-gray-600 dark:text-gray-400">
          {panel.head ? `${panel.behind} waiting behind it` : 'nothing queued'}
          {panel.gaveUp.length > 0 ? ` · ${panel.gaveUp.length} given up on this week` : ''}
        </span>
      </summary>
      <ul className="mt-1 divide-y divide-gray-100 dark:divide-gray-800">
        {panel.head ? <Line agentId={agentId} line={panel.head} /> : null}
        {panel.batches.map((line, index) => (
          <Line key={`batch-${index}`} agentId={agentId} line={line} />
        ))}
        {panel.gaveUp.map((line, index) => (
          <Line key={`dead-${index}`} agentId={agentId} line={line} />
        ))}
      </ul>
    </details>
  );
}
