'use client';

import { useEffect, useState } from 'react';

/**
 * How long something has been running, in ms: from `startedAt` to
 * `finishedAt` once that is known, otherwise to now, re-read every
 * second while `running`. Null when there is no start to count from.
 */
export function useElapsedMs(
  startedAt: number | null,
  finishedAt: number | null,
  running: boolean
): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === null || finishedAt !== null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running, startedAt, finishedAt]);
  if (startedAt === null) return null;
  return Math.max(0, (finishedAt ?? now) - startedAt);
}
