'use client';

import { useEffect, useState } from 'react';

/**
 * The MCP endpoint URL with a copy button — the artifact a user pastes into
 * their LLM app. Client-side because the displayed URL must be the origin the
 * browser actually reached, which the server behind a proxy cannot know.
 *
 * It sits in a full-width row of its own above the connector columns, so the
 * layout here is a band rather than a stack: the explanation on the left, the
 * URL and its button on the right. Stacked full-width, a 60-character URL
 * left a metre of empty grey behind it; side by side, the row is doing two
 * jobs with the width instead of padding one.
 */
export default function McpEndpoint({ tenantId }: { tenantId: string }) {
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setUrl(`${window.location.origin}/api/mcp/${tenantId}/http`);
  }, [tenantId]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (http, permissions): the URL is selectable text.
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        <div className="min-w-0">
          <h2 className="font-semibold">MCP endpoint</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Give this URL to Claude or any MCP-capable app. It will walk you through authorizing.
          </p>
        </div>
        {/* `whitespace-nowrap` keeps the URL one copyable line; the scroll is
            what absorbs a long tenant id rather than a mid-path wrap. */}
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-gray-100 p-2 font-mono text-xs dark:bg-gray-900 lg:flex-none">
            {url || '…'}
          </code>
          <button
            onClick={() => void copy()}
            disabled={!url}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
