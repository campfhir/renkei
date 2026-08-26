'use client';

/**
 * The runs list's search box — a small client island over an otherwise
 * server-rendered page. It writes the text into the URL (?q=) debounced,
 * so the filtered view stays linkable and back-button-able and the
 * filtering itself stays in the query seam with its redaction rules;
 * the active status tab rides along untouched.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export default function RunsSearch({
  basePath,
  status,
  initialQ,
}: {
  /** The runs page path without query, e.g. `/${slug}/agents/${agentId}/runs`. */
  basePath: string;
  /** The active status filter, kept in the URL alongside the search. */
  status?: string;
  initialQ: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQ);
  const first = useRef(true);

  useEffect(() => {
    // Skip the mount: replacing the URL with what it already says would
    // only add a history-adjacent no-op on every page load.
    if (first.current) {
      first.current = false;
      return;
    }
    const handle = setTimeout(() => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      const q = value.trim();
      if (q) params.set('q', q);
      const query = params.toString();
      router.replace(query ? `${basePath}?${query}` : basePath);
    }, 300);
    return () => clearTimeout(handle);
  }, [value, status, basePath, router]);

  return (
    <input
      type="search"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder="Search runs — trigger text, error, or a run id"
      aria-label="Search runs"
      className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 sm:max-w-xs"
    />
  );
}
