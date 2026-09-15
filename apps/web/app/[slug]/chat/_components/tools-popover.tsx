'use client';

/**
 * Which connectors this chat may use. The core set is on when nothing
 * has been chosen; toggling anything pins an explicit list on the chat.
 * The list comes from the person's own catalog, so a connector they have
 * not linked never appears here — except one the chat's project requires
 * (`locked`, e.g. Bitbucket in a code project), which is shown checked
 * and cannot be unchecked, or, when the person has not linked it, as
 * missing, with where to link it.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';
import { chatClient } from '@/lib/chat/client';
import type { ConnectorOption } from '@/lib/chat/tool-surface';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { LoadingLine } from '@/components/skeleton';

/** Catalog label for a capability key, falling back to the key itself. */
function connectorLabel(key: string): string {
  return CONNECTOR_CATALOG.find((entry) => entry.capabilityKey === key)?.label ?? key;
}

export default function ToolsPopover({
  tenantId,
  selected,
  onChange,
  context = 'chat',
  slug,
  locked,
}: {
  tenantId: string;
  /** null = the core set. */
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
  /**
   * 'chat' (the default) offers "Save as my default" / "Clear my default" —
   * both write the person's own cross-chat preference. 'project' hides
   * them: a project's toolset is its own stored setting (already saved the
   * moment a box here is toggled), not a stand-in for that personal
   * default, and letting this popover write the user-level preference from
   * inside a project's settings reads as "set this project's default" when
   * it is actually changing something else entirely.
   */
  context?: 'chat' | 'project';
  /** Only used in project context, to link out to where the personal default lives. */
  slug?: string;
  /**
   * Connectors that are always on in this chat, whatever is chosen — a
   * code project's Bitbucket (tool-config.ts's CODE_PROJECT_CONNECTORS).
   * The server adds them to every turn's toolset too; here they render
   * checked and disabled so the picker says what the turn will do.
   */
  locked?: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConnectorOption[] | null>(null);
  const [core, setCore] = useState<string[]>([]);
  const [userDefault, setUserDefault] = useState<string[] | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));

  useEffect(() => {
    if (!open || options !== null) return;
    void chatClient.connectors(tenantId).then((result) => {
      if (result.data) {
        setOptions(result.data.connectors);
        setCore(result.data.core);
        setUserDefault(result.data.userDefault?.connectors ?? null);
      } else {
        setOptions([]);
      }
    });
  }, [open, options, tenantId]);

  const lockedKeys = locked ?? [];
  const effective = new Set([...(selected ?? userDefault ?? core), ...lockedKeys]);
  const count = selected ? selected.length : null;
  // A required connector the person has not linked: nothing in the catalog
  // for it, so no row below would mention it — and it is the one the chat
  // most needs to say something about.
  const missingLocked = lockedKeys.filter(
    (key) => options !== null && !options.some((option) => option.key === key)
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Tools"
        title="Which tools the assistant may use"
        className="flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
      >
        <Icon path={ICONS.tool} className="h-4 w-4" />
        <span className="hidden sm:inline">Tools</span>
        {count !== null ? <span className="text-gray-400">{count}</span> : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-40 mt-1 w-64 rounded-md border border-gray-200 bg-white p-2 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900">
          <p className="mb-1 px-1 text-xs text-gray-500">
            {context === 'project'
              ? 'Connectors chats in this project start with, unless a chat picks its own.'
              : 'Connectors the assistant may use in this chat.'}
          </p>
          {options === null ? (
            <LoadingLine size="xs" className="px-1" label="Loading connectors…" />
          ) : options.length === 0 ? (
            <p className="px-1 text-xs text-gray-500">
              Nothing connected yet — link a connector on the Connectors page.
            </p>
          ) : (
            options.map((option) => {
              const isLocked = lockedKeys.includes(option.key);
              return (
                <label
                  key={option.key}
                  title={isLocked ? 'Always on in a code project' : undefined}
                  className={`flex items-center gap-2 rounded px-1 py-1 ${
                    isLocked ? 'cursor-default' : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={effective.has(option.key)}
                    disabled={isLocked}
                    aria-label={
                      isLocked
                        ? `${connectorLabel(option.key)} (always on in a code project)`
                        : undefined
                    }
                    onChange={(event) => {
                      const next = new Set(effective);
                      if (event.target.checked) next.add(option.key);
                      else next.delete(option.key);
                      onChange([...next].sort());
                    }}
                  />
                  <span className="flex-1">{connectorLabel(option.key)}</span>
                  {isLocked ? (
                    <Icon path={ICONS.lock} className="h-3.5 w-3.5 text-gray-400" />
                  ) : null}
                  <span className="text-xs text-gray-400">{option.count}</span>
                </label>
              );
            })
          )}
          {missingLocked.map((key) => (
            <div
              key={key}
              className="flex items-center gap-2 rounded px-1 py-1 text-gray-400"
              title="Always on in a code project, but not linked yet"
            >
              <input
                type="checkbox"
                checked
                disabled
                readOnly
                aria-label={`${connectorLabel(key)} (always on in a code project, not linked yet)`}
              />
              <span className="flex-1">
                {connectorLabel(key)}
                {' — '}
                {slug ? (
                  <a
                    href={`/${slug}/connectors`}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    not linked yet
                  </a>
                ) : (
                  'not linked yet'
                )}
              </span>
              <Icon path={ICONS.lock} className="h-3.5 w-3.5" />
            </div>
          ))}
          {selected ? (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="mt-1 px-1 text-xs text-blue-600 hover:underline"
            >
              Reset to defaults
            </button>
          ) : null}
          {context === 'chat' && options !== null && options.length > 0 ? (
            <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2 text-xs dark:border-gray-700">
              <button
                type="button"
                disabled={savingDefault}
                onClick={() => {
                  setSavingDefault(true);
                  void chatClient
                    .setDefaultTools(tenantId, [...effective].sort())
                    .then((result) => {
                      if (result.data) setUserDefault(result.data.userDefault?.connectors ?? null);
                      setSavingDefault(false);
                    });
                }}
                className="text-blue-600 hover:underline disabled:opacity-50"
              >
                Save as my default
              </button>
              {userDefault ? (
                <button
                  type="button"
                  disabled={savingDefault}
                  onClick={() => {
                    setSavingDefault(true);
                    void chatClient.setDefaultTools(tenantId, null).then(() => {
                      setUserDefault(null);
                      setSavingDefault(false);
                    });
                  }}
                  className="text-gray-500 hover:underline disabled:opacity-50"
                >
                  Clear my default
                </button>
              ) : null}
            </div>
          ) : null}
          {context === 'project' && options !== null && options.length > 0 ? (
            <p className="mt-2 border-t border-gray-200 pt-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              This is saved on the project as soon as you toggle it. Your personal default for new
              chats outside this project lives in{' '}
              {slug ? (
                <a
                  href={`/${slug}/preferences`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  Preferences
                </a>
              ) : (
                'Preferences'
              )}
              .
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
