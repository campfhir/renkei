'use client';

/**
 * Which connectors this chat may use, in a dialog. The default for the
 * chat's kind is on when nothing has been chosen — the person's saved
 * chat default, else the core set, in an ordinary chat; their saved
 * code-project default, else the code default, in a code project's chat
 * or on a code project — and toggling anything pins an explicit list on
 * the chat. The list comes from the person's own catalog, so a
 * connector they have not linked never appears here — except one the
 * chat's project requires (`locked`, e.g. Bitbucket in a code project),
 * which is shown checked and cannot be unchecked, or, when the person
 * has not linked it, as missing, with where to link it.
 *
 * A dialog rather than a popover: the catalog has grown past what a
 * popover can show without running off the screen, so the list scrolls
 * in a box of its own under the explanation, and the actions — Reset to
 * defaults, Save as my default, Clear my default, Done — stay put in a
 * footer whatever the list's length or the screen's height. A filter
 * box narrows the list by name.
 */

import { useEffect, useMemo, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import type { ConnectorOption } from '@/lib/chat/tool-surface';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { LoadingLine } from '@/components/skeleton';
import { useCoachAnchor } from '@/components/coach-marks/anchor';

/** Catalog label for a capability key, falling back to the key itself. */
function connectorLabel(key: string): string {
  return CONNECTOR_CATALOG.find((entry) => entry.capabilityKey === key)?.label ?? key;
}

const footerButton =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';

export default function ToolsDialog({
  selected,
  onChange,
  context = 'chat',
  kind = 'chat',
  locked,
  saveDefault,
  projectDefault = null,
  open: controlledOpen,
  onOpenChange,
  trigger = true,
}: {
  /** null = the core set. */
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
  /**
   * 'chat' (the default) offers "Save as my default" / "Clear my default" —
   * both write the person's own cross-chat preference. 'project' hides
   * them: a project's toolset is its own stored setting (already saved the
   * moment a box here is toggled), not a stand-in for that personal
   * default, and letting this dialog write the user-level preference from
   * inside a project's settings reads as "set this project's default" when
   * it is actually changing something else entirely.
   */
  context?: 'chat' | 'project';
  /**
   * Which defaults apply when nothing is chosen, and which personal default
   * the save actions write: 'chat' (the person's chat default, else the
   * core set) or 'code' (their code-project default, else the code default
   * — tool-config.ts, tool-prefs.ts).
   */
  kind?: 'chat' | 'code';
  /** Offer the personal-default actions whatever the context (the new code project form). */
  saveDefault?: boolean;
  /**
   * The chat's project's own toolset (null outside a project, or when the
   * project has none) — the tier between "nothing chosen on this chat" and
   * the person's personal default, matching the server's chat ?? project ??
   * userDefault ?? default chain (tool-config.ts's effectiveToolConfig).
   * Only meaningful in `context: 'chat'`; a project's own dialog has no
   * higher tier than personal/built-in.
   */
  projectDefault?: string[] | null;
  /**
   * Connectors that are always on in this chat, whatever is chosen — a
   * code project's Bitbucket and GitHub (tool-config.ts's
   * CODE_PROJECT_CONNECTORS). The server adds them to every turn's
   * toolset too; here they render checked and disabled so the picker
   * says what the turn will do.
   */
  locked?: readonly string[];
  /**
   * Opened from elsewhere — a menu item (the project page's "⋯" → Tools):
   * the caller holds whether it is open and gets told when it should
   * close, and `trigger: false` leaves out the button.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: boolean;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setOwnOpen(next);
  };
  const toolsAnchor = useCoachAnchor('chat-tools');
  const [options, setOptions] = useState<ConnectorOption[] | null>(null);
  const [core, setCore] = useState<string[]>([]);
  const [codeDefault, setCodeDefault] = useState<string[]>([]);
  const [userDefault, setUserDefault] = useState<string[] | null>(null);
  const [userCodeDefault, setUserCodeDefault] = useState<string[] | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const [savedWord, setSavedWord] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!open || options !== null) return;
    void chatClient.connectors().then((result) => {
      if (result.data) {
        setOptions(result.data.connectors);
        setCore(result.data.core);
        setCodeDefault(result.data.codeDefault ?? []);
        setUserDefault(result.data.userDefault?.connectors ?? null);
        setUserCodeDefault(result.data.userCodeDefault?.connectors ?? null);
      } else {
        setOptions([]);
      }
    });
  }, [open, options]);

  // A fresh look each time: the filter and the "Saved" word are for one opening.
  useEffect(() => {
    if (!open) {
      setFilter('');
      setSavedWord(null);
    }
  }, [open]);

  const lockedKeys = locked ?? [];
  const personal = kind === 'code' ? userCodeDefault : userDefault;
  const setPersonal = kind === 'code' ? setUserCodeDefault : setUserDefault;
  const fallback = projectDefault ?? personal ?? (kind === 'code' ? codeDefault : core);
  const effective = new Set([...(selected ?? fallback), ...lockedKeys]);
  const offersDefault = saveDefault ?? context === 'chat';
  const count = selected ? selected.length : null;
  // A required connector the person has not linked: nothing in the catalog
  // for it, so no row below would mention it — and it is the one the chat
  // most needs to say something about.
  const missingLocked = lockedKeys.filter(
    (key) => options !== null && !options.some((option) => option.key === key)
  );
  const shown = useMemo(() => {
    if (!options) return null;
    const needle = filter.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => connectorLabel(option.key).toLowerCase().includes(needle));
  }, [options, filter]);

  const explanation =
    context === 'project'
      ? kind === 'code'
        ? 'Connectors chats in this project start with, unless a chat picks its own — from your default for code projects, or the code default.'
        : 'Connectors chats in this project start with, unless a chat picks its own.'
      : kind === 'code'
        ? 'Connectors the assistant may use in this chat. A code project’s chat starts from the project’s toolset, else your default for code projects, else the code default.'
        : projectDefault
          ? 'Connectors the assistant may use in this chat. Starts from this project’s toolset, unless you pick your own.'
          : 'Connectors the assistant may use in this chat.';

  const saveAsDefault = () => {
    setSavingDefault(true);
    setSavedWord(null);
    void chatClient.setDefaultTools([...effective].sort(), kind).then((result) => {
      if (result.data) {
        setPersonal(result.data.userDefault?.connectors ?? null);
        setSavedWord('Saved as your default.');
      }
      setSavingDefault(false);
    });
  };
  const clearDefault = () => {
    setSavingDefault(true);
    setSavedWord(null);
    void chatClient.setDefaultTools(null, kind).then(() => {
      setPersonal(null);
      setSavedWord('Your default is cleared.');
      setSavingDefault(false);
    });
  };

  return (
    <>
      {trigger ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label="Tools"
          title="Which tools the assistant may use"
          {...toolsAnchor}
          className="flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
        >
          <Icon path={ICONS.tool} className="h-4 w-4" />
          <span className="hidden sm:inline">Tools</span>
          {count !== null ? <span className="text-gray-400">{count}</span> : null}
        </button>
      ) : null}
      {open ? (
        <Modal title="Tools" onClose={() => setOpen(false)}>
          <div className="flex max-h-[75vh] flex-col text-sm" data-testid="tools-dialog">
            <p className="mb-2 text-xs text-gray-500">{explanation}</p>
            {options !== null && options.length > 8 ? (
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter connectors"
                aria-label="Filter connectors"
                autoComplete="off"
                className="mb-2 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
              />
            ) : null}
            <div
              className="min-h-0 flex-1 overflow-y-auto rounded-md border border-gray-200 p-1 dark:border-gray-800"
              data-testid="tools-dialog-list"
            >
              {options === null ? (
                <LoadingLine size="xs" className="px-1 py-1" label="Loading connectors…" />
              ) : options.length === 0 ? (
                <p className="px-1 py-1 text-xs text-gray-500">
                  Nothing connected yet — link a connector on the Connectors page.
                </p>
              ) : shown && shown.length === 0 ? (
                <p className="px-1 py-1 text-xs text-gray-500">
                  No connector is called “{filter.trim()}”.
                </p>
              ) : (
                (shown ?? []).map((option) => {
                  const isLocked = lockedKeys.includes(option.key);
                  return (
                    <label
                      key={option.key}
                      title={isLocked ? 'Always on in a code project' : undefined}
                      className={`flex items-center gap-2 rounded px-2 py-1.5 ${
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
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-gray-400"
                  title="Always on in a code project, but not linked yet"
                >
                  <input
                    type="checkbox"
                    checked
                    disabled
                    aria-label={`${connectorLabel(key)} (always on in a code project, not linked yet)`}
                  />
                  <span className="flex-1">
                    {connectorLabel(key)}
                    {' — '}
                    <a
                      href={`/connectors`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      not linked yet
                    </a>
                  </span>
                  <Icon path={ICONS.lock} className="h-3.5 w-3.5" />
                </div>
              ))}
            </div>
            {context === 'project' && !offersDefault && options !== null && options.length > 0 ? (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Saved on the project as soon as you toggle it. Your personal default for new chats
                outside this project lives in{' '}
                <a href={`/preferences`} className="text-blue-600 hover:underline dark:text-blue-400">
                  Preferences
                </a>
                .
              </p>
            ) : null}
            <div
              className="mt-3 flex shrink-0 flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800"
              data-testid="tools-dialog-footer"
            >
              {savedWord ? (
                <span role="status" className="text-xs text-green-700 dark:text-green-400">
                  {savedWord}
                </span>
              ) : null}
              {selected ? (
                <button
                  type="button"
                  onClick={() => onChange(null)}
                  className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                >
                  Reset to defaults
                </button>
              ) : null}
              <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                {offersDefault && options !== null && options.length > 0 ? (
                  <>
                    {personal ? (
                      <button
                        type="button"
                        disabled={savingDefault}
                        onClick={clearDefault}
                        className={footerButton}
                      >
                        Clear my default
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={savingDefault}
                      onClick={saveAsDefault}
                      className={footerButton}
                    >
                      {savingDefault
                        ? 'Saving…'
                        : kind === 'code'
                          ? 'Save as my default for code projects'
                          : 'Save as my default'}
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Done
                </button>
              </span>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
