'use client';

/**
 * "Copy as Markdown" — puts the agent's whole definition (built server-side
 * by lib/agents/export-markdown.ts, any steps version) on the clipboard.
 *
 * Sized like Share and Edit beside it (px-3 py-1.5 text-sm): the header row
 * reads as one strip of controls, and a button half the height of its
 * neighbours looked like a different KIND of thing.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';

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
      className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
    >
      <Icon path={copied ? ICONS.check : ICONS.copy} />
      {copied ? 'Copied' : 'Copy as Markdown'}
    </button>
  );
}
