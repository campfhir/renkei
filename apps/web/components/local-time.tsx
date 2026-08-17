'use client';

import { useEffect, useState } from 'react';

/**
 * A timestamp in the VIEWER's timezone.
 *
 * Server components render on the server, so a `toLocaleString()` there
 * speaks the server's clock — a run at 9am reads as 2pm to whoever asked.
 * This is the one client boundary for that: SSR and the hydration pass
 * both emit a deterministic UTC string (anything locale- or zone-dependent
 * would differ between server and browser and tear on hydration), and the
 * first client effect swaps in the local rendering. The brief UTC flash is
 * the honest version of the value, not a loading state.
 */
export default function LocalTime({
  at,
  format = 'datetime',
  className,
}: {
  /** ISO timestamp (or anything Date can parse). */
  at: string | number | Date;
  format?: 'datetime' | 'date' | 'time';
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;

  let text: string;
  if (mounted) {
    text =
      format === 'date'
        ? date.toLocaleDateString()
        : format === 'time'
          ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : date.toLocaleString([], {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            });
  } else {
    const iso = date.toISOString();
    text =
      format === 'date'
        ? iso.slice(0, 10)
        : format === 'time'
          ? `${iso.slice(11, 16)} UTC`
          : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  }

  return (
    <time dateTime={date.toISOString()} title={date.toISOString()} className={className}>
      {text}
    </time>
  );
}
