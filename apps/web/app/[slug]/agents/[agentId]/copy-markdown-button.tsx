'use client';

/**
 * "Copy as Markdown" — puts the agent's whole definition (built server-side
 * by lib/agents/export-markdown.ts, any steps version) on the clipboard.
 */

import { useEffect, useRef, useState } from 'react';

export default function CopyMarkdownButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return (
    <button
      type="button"
      title="Copy this agent's whole definition — triggers, guardrails, steps — as markdown."
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(markdown);
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard denied (permissions, http): fall back to a download.
          const blob = new Blob([markdown], { type: 'text/markdown' });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = 'agent.md';
          anchor.click();
          URL.revokeObjectURL(url);
        }
      }}
      className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
    >
      {copied ? 'Copied ✓' : 'Copy as Markdown'}
    </button>
  );
}
