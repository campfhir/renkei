'use client';

import { useEffect, useState } from 'react';

export default function AccessCountBadge({
  agentId,
}: {
  agentId: string;
}) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const fetchCount = async () => {
      try {
        const response = await fetch(`/api/agents/${agentId}/access-count`);
        if (!response.ok) return;
        const data: { count?: number } = await response.json().catch(() => ({}));
        setCount(data.count ?? 0);
      } catch {
        // silently fail if the endpoint doesn't exist
      }
    };
    void fetchCount();
  }, [agentId]);

  if (count === null || count === 0) return null;

  return (
    <span
      title={`${count} ${count === 1 ? 'colleague' : 'colleagues'} can read and edit this agent`}
      className="shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300"
    >
      Shared with {count}
    </span>
  );
}
