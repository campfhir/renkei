'use client';

/**
 * The person's saved default chat toolset — the actual, discoverable home
 * for the preference that tools-popover.tsx's "Save as my default" /
 * "Clear my default" links write to. Those links exist for convenience
 * mid-chat; this section is where someone finds and changes the setting on
 * its own, without needing to already be in a chat.
 */

import { useState } from 'react';
import { chatClient } from '@/lib/chat/client';

interface ChatToolOption {
  key: string;
  label: string;
  count: number;
  core: boolean;
}

export default function DefaultToolsForm({
  tenantId,
  connectors,
  initialDefault,
}: {
  tenantId: string;
  connectors: ChatToolOption[];
  /** null = no saved default yet — a new chat falls back to the core set. */
  initialDefault: string[] | null;
}) {
  const [selected, setSelected] = useState<string[] | null>(initialDefault);
  const [savedDefault, setSavedDefault] = useState<string[] | null>(initialDefault);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  const core = connectors.filter((option) => option.core).map((option) => option.key);
  const effective = new Set(selected ?? core);

  function toggle(key: string, on: boolean) {
    const next = new Set(effective);
    if (on) next.add(key);
    else next.delete(key);
    setSelected([...next].sort());
    setStatus('idle');
  }

  async function save() {
    setStatus('saving');
    const result = await chatClient.setDefaultTools(tenantId, [...effective].sort());
    if (result.data) {
      setSavedDefault(result.data.userDefault?.connectors ?? null);
      setStatus('saved');
    } else {
      setStatus('failed');
    }
  }

  async function clear() {
    setStatus('saving');
    const result = await chatClient.setDefaultTools(tenantId, null);
    if (!result.error) {
      setSelected(null);
      setSavedDefault(null);
      setStatus('saved');
    } else {
      setStatus('failed');
    }
  }

  return (
    <section
      aria-labelledby="default-tools-heading"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="default-tools-heading" className="font-semibold">
        Default tools for new chats
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        What a brand new chat starts with, before you pick anything for it — a project you start the
        chat in still wins over this if it has its own toolset, and anything you change inside a
        specific chat only ever affects that chat.
      </p>

      {connectors.length === 0 ? (
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Nothing connected yet — link a connector on the Connectors page.
        </p>
      ) : (
        <div className="mt-3 space-y-1">
          {connectors.map((option) => (
            <label
              key={option.key}
              className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
            >
              <input
                type="checkbox"
                checked={effective.has(option.key)}
                onChange={(event) => toggle(option.key, event.target.checked)}
              />
              <span className="flex-1">{option.label}</span>
              <span className="text-xs text-gray-400">{option.count}</span>
            </label>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving' || connectors.length === 0}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save default'}
        </button>
        {savedDefault !== null ? (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={status === 'saving'}
            className="text-sm text-gray-500 hover:underline disabled:opacity-50"
          >
            Reset to the core set
          </button>
        ) : null}
        {status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">Could not save.</span>
        ) : null}
      </div>
    </section>
  );
}
