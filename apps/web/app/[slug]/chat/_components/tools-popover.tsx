'use client';

/**
 * Which connectors this chat may use. The core set is on when nothing
 * has been chosen; toggling anything pins an explicit list on the chat.
 * The list comes from the person's own catalog, so a connector they have
 * not linked never appears here.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';
import { chatClient } from '@/lib/chat/client';
import type { ConnectorOption } from '@/lib/chat/tool-surface';

const LABELS: Record<string, string> = {
  knowledge: 'Knowledge',
  sandbox: 'Sandbox',
  jira: 'Jira',
  jsm: 'Service Management',
  confluence: 'Confluence',
  bitbucket: 'Bitbucket',
  webex: 'WebEx',
  outlook: 'Outlook',
  sharepoint: 'SharePoint',
  onedrive: 'OneDrive',
  zoom: 'Zoom',
  fileshares: 'File shares',
  onbase: 'OnBase',
  agents: 'Agents',
  cards: 'Cards',
  batch: 'Batch jobs',
};

export default function ToolsPopover({
  tenantId,
  selected,
  onChange,
}: {
  tenantId: string;
  /** null = the core set. */
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConnectorOption[] | null>(null);
  const [core, setCore] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));

  useEffect(() => {
    if (!open || options !== null) return;
    void chatClient.connectors(tenantId).then((result) => {
      if (result.data) {
        setOptions(result.data.connectors);
        setCore(result.data.core);
      } else {
        setOptions([]);
      }
    });
  }, [open, options, tenantId]);

  const effective = new Set(selected ?? core);
  const count = selected ? selected.length : null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Tools"
        title="Which tools the assistant may use"
        className="flex items-center gap-1 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
      >
        <Icon path={ICONS.tool} className="h-5 w-5" />
        {count !== null ? <span className="text-xs">{count}</span> : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-40 mt-1 w-64 rounded-md border border-gray-200 bg-white p-2 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <p className="mb-1 px-1 text-xs text-gray-500">
            Connectors the assistant may use in this chat.
          </p>
          {options === null ? (
            <p className="px-1 text-xs text-gray-500">Loading…</p>
          ) : options.length === 0 ? (
            <p className="px-1 text-xs text-gray-500">
              Nothing connected yet — link a connector on the Connectors page.
            </p>
          ) : (
            options.map((option) => (
              <label
                key={option.key}
                className="flex items-center gap-2 rounded px-1 py-1 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <input
                  type="checkbox"
                  checked={effective.has(option.key)}
                  onChange={(event) => {
                    const next = new Set(effective);
                    if (event.target.checked) next.add(option.key);
                    else next.delete(option.key);
                    onChange([...next].sort());
                  }}
                />
                <span className="flex-1">{LABELS[option.key] ?? option.key}</span>
                <span className="text-xs text-gray-400">{option.count}</span>
              </label>
            ))
          )}
          {selected ? (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="mt-1 px-1 text-xs text-blue-600 hover:underline"
            >
              Reset to defaults
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
