'use client';

/**
 * The Code list's search box — a small client island over a
 * server-rendered page. It writes the text into the URL (?q=), debounced,
 * which also sends the list back to its first page; the filtering is
 * code-index.model.ts's, on the server.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { codeIndexHref } from './code-index.model';

export default function CodeSearch({ initialQ }: { initialQ: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialQ);
  const first = useRef(true);

  useEffect(() => {
    // Skip the mount: the URL already says what the box does.
    if (first.current) {
      first.current = false;
      return;
    }
    const handle = setTimeout(() => {
      router.replace(codeIndexHref({ q: value.trim(), page: 1 }));
    }, 300);
    return () => clearTimeout(handle);
  }, [value, router]);

  return (
    <input
      type="search"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder="Search projects"
      aria-label="Search code projects"
      className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 sm:max-w-xs"
    />
  );
}
