'use client';

/**
 * "Copy for debugging" — puts server-rendered debug markdown on the
 * clipboard for pasting into Claude Code or another dev tool. The text
 * arrives fully built from the page (same projection it renders, so
 * redaction carries over); this component only copies it.
 */

import { useState } from 'react';

export default function CopyDebugButton({ text }: { text: string }): React.ReactNode {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The async clipboard API needs a secure context (http://renkei.local
      // style dev hosts lack one) — the legacy path has no such rule.
      const holder = document.createElement('textarea');
      holder.value = text;
      document.body.appendChild(holder);
      holder.select();
      document.execCommand('copy');
      holder.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
    >
      {copied ? 'Copied ✓' : 'Copy for debugging'}
    </button>
  );
}
