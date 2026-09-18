'use client';

/**
 * The tools a chat may call without asking — every "Always allow" a person
 * has ever clicked on a chat's permission card, in one place, each with a
 * way to take it back. The chat asks before any call that changes
 * something; a name on this list skips the ask for that tool in every chat
 * the person owns, from the next Send on.
 */

import { useState } from 'react';
import { friendlyToolName } from '@/lib/tool-name';
import { chatClient } from '@/lib/chat/client';
import { Icon, ICONS } from '@/components/icons';

export default function ToolPermissionsForm({
  tenantId,
  initial,
}: {
  tenantId: string;
  initial: string[];
}) {
  const [names, setNames] = useState<string[]>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'failed'>('idle');

  async function remove(name: string) {
    const next = names.filter((entry) => entry !== name);
    setStatus('saving');
    const result = await chatClient.setToolPermissions(tenantId, next);
    if (result.data) {
      setNames(result.data.alwaysAllow);
      setStatus('idle');
    } else {
      setStatus('failed');
    }
  }

  return (
    <section
      aria-labelledby="tool-permissions-heading"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="tool-permissions-heading" className="font-semibold">
        Tools chats may use without asking
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        A chat asks before it does anything that changes something — files an issue, sends a
        message, writes a file — and &ldquo;Always allow&rdquo; on that card puts the tool here.
        Reading never asks. Take a tool off the list and the next chat that wants it asks again.
      </p>
      {names.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Nothing yet — every tool that changes something still asks.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-900">
          {names.map((name) => (
            <li key={name} className="flex items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{friendlyToolName(name, null)}</span>
                <code className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                  {name}
                </code>
              </span>
              <button
                type="button"
                disabled={status === 'saving'}
                onClick={() => void remove(name)}
                aria-label={`Ask again before ${friendlyToolName(name, null)}`}
                className="flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                <Icon path={ICONS.close} className="h-3.5 w-3.5" />
                Ask again
              </button>
            </li>
          ))}
        </ul>
      )}
      {status === 'failed' ? (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">Could not save.</p>
      ) : null}
    </section>
  );
}
