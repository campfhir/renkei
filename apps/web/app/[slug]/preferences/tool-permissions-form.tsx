'use client';

/**
 * What a chat may do without asking, and what it may never do — decided
 * per tool, ahead of time.
 *
 * Every act tool the person can reach is listed (permission-catalog.ts),
 * one fold per connector plus the chat's own tools and a code project's,
 * shut by default: there are a couple of hundred act tools across the
 * connectors, and a page that laid them all out flat would be a wall.
 * Each fold's line says how many of its tools are allowed or blocked, so
 * a shut fold still tells the person where their decisions are.
 *
 * Three answers per tool: Ask (the default — the chat parks and its card
 * asks), Allow (runs unasked; what "Always allow" on the card writes),
 * Block (never offered to the model, refused if it calls the name from
 * memory). A connector-wide "all" for each answer sits at the top of its
 * fold. Nothing is saved until Save, like the notifications form: a
 * person working through a connector should not fire a request per click.
 */

import { useMemo, useState } from 'react';
import ConnectorIcon from '@/components/connector-icon';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
// The PURE half, not permission-prefs.ts: that one reaches the database,
// and a client component that pulled it in would drag `pg` into the bundle.
import {
  CHAT_OWN_TOOLS_KEY,
  CODE_TOOLS_KEY,
  parseChatToolPermissionPrefs,
  ruleFor,
  withRule,
  type ActToolGroup,
  type ChatToolPermissionPrefs,
  type ToolPermissionRule,
} from '@/lib/chat/permission-rules';

const RULES: readonly { rule: ToolPermissionRule; label: string; hint: string }[] = [
  { rule: 'ask', label: 'Ask', hint: 'The chat stops and asks each time.' },
  { rule: 'allow', label: 'Allow', hint: 'Runs without asking.' },
  { rule: 'deny', label: 'Block', hint: 'Never offered to the chat; refused if it tries.' },
];

export default function ToolPermissionsForm({
  tenantId,
  groups,
  initial,
}: {
  tenantId: string;
  groups: ActToolGroup[];
  initial: ChatToolPermissionPrefs;
}) {
  const [prefs, setPrefs] = useState<ChatToolPermissionPrefs>(initial);
  const [saved, setSaved] = useState<ChatToolPermissionPrefs>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  const dirty = useMemo(
    () =>
      prefs.alwaysAllow.join('\n') !== saved.alwaysAllow.join('\n') ||
      prefs.alwaysDeny.join('\n') !== saved.alwaysDeny.join('\n'),
    [prefs, saved]
  );

  function update(next: ChatToolPermissionPrefs) {
    setPrefs(next);
    setStatus('idle');
  }

  function setAll(group: ActToolGroup, rule: ToolPermissionRule) {
    let next = prefs;
    for (const tool of group.tools) next = withRule(next, tool.name, rule);
    update(next);
  }

  async function save() {
    setStatus('saving');
    const result = await chatClient.setToolPermissions(tenantId, prefs);
    if (result.data) {
      const stored = parseChatToolPermissionPrefs(result.data);
      setPrefs(stored);
      setSaved(stored);
      setStatus('saved');
    } else {
      setStatus('failed');
    }
  }

  // Decisions saved for tools this build no longer lists (a connector
  // turned off, a tool renamed) — kept, and said, rather than silently
  // dropped on the next Save.
  const listed = useMemo(
    () => new Set(groups.flatMap((group) => group.tools.map((tool) => tool.name))),
    [groups]
  );
  const unlisted = [...prefs.alwaysAllow, ...prefs.alwaysDeny].filter((name) => !listed.has(name));

  return (
    <section
      aria-labelledby="tool-permissions-heading"
      className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
    >
      <div className="p-4 pb-3">
        <h3 id="tool-permissions-heading" className="font-semibold">
          What a chat may do
        </h3>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
          A chat asks before it does anything that changes something — files an issue, sends a
          message, writes a file. Decide ahead of time here, per tool: keep asking, allow it without
          asking, or block it so the chat never sees it. &ldquo;Always allow&rdquo; on a
          chat&rsquo;s permission card lands here too. Reading never asks.
        </p>
      </div>

      <div className="space-y-1.5 border-t border-gray-200 px-4 py-3 dark:border-gray-800">
        {groups.map((group) => {
          const allowed = group.tools.filter((tool) => ruleFor(prefs, tool.name) === 'allow');
          const blocked = group.tools.filter((tool) => ruleFor(prefs, tool.name) === 'deny');
          const summary = [
            allowed.length > 0 ? `${allowed.length} allowed` : null,
            blocked.length > 0 ? `${blocked.length} blocked` : null,
          ]
            .filter((part) => part !== null)
            .join(', ');
          return (
            <details
              key={group.key}
              className="rounded-lg border border-gray-200 dark:border-gray-800"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm">
                {group.key === CHAT_OWN_TOOLS_KEY ? (
                  <Icon path={ICONS.chat} className="h-4 w-4 shrink-0 text-gray-500" />
                ) : group.key === CODE_TOOLS_KEY ? (
                  <Icon path={ICONS.code} className="h-4 w-4 shrink-0 text-gray-500" />
                ) : (
                  <ConnectorIcon capabilityKey={group.key} label={group.label} size={16} />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                  {summary || `${group.tools.length} ask`}
                </span>
                <span aria-hidden="true" className="shrink-0 text-gray-400">
                  ▾
                </span>
              </summary>

              <div className="border-t border-gray-200 dark:border-gray-800">
                <div className="flex flex-wrap items-center gap-3 px-3 pt-3 text-xs">
                  <span className="text-gray-500 dark:text-gray-400">All of {group.label}:</span>
                  {RULES.map(({ rule, label }) => (
                    <button
                      key={rule}
                      type="button"
                      onClick={() => setAll(group, rule)}
                      className={
                        rule === 'deny'
                          ? 'text-red-600 hover:underline dark:text-red-400'
                          : 'text-blue-600 hover:underline dark:text-blue-400'
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] border-collapse text-sm">
                    <thead>
                      <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                        <th className="px-3 py-2 font-medium">Tool</th>
                        {RULES.map(({ rule, label, hint }) => (
                          <th key={rule} className="w-16 px-2 py-2 text-center font-medium">
                            <span title={hint}>{label}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.tools.map((tool) => {
                        const current = ruleFor(prefs, tool.name);
                        return (
                          <tr
                            key={tool.name}
                            className={`border-t border-gray-100 dark:border-gray-900 ${
                              current === 'deny' ? 'bg-red-50/60 dark:bg-red-950/20' : ''
                            }`}
                          >
                            <td className="px-3 py-2 align-top">
                              <span className="font-medium">{tool.label}</span>
                              <code className="ml-2 font-mono text-xs text-gray-500 dark:text-gray-400">
                                {tool.name}
                              </code>
                            </td>
                            {RULES.map(({ rule, label }) => (
                              <td key={rule} className="px-2 py-2 text-center align-top">
                                <input
                                  type="radio"
                                  name={`tool-rule:${tool.name}`}
                                  // The wire name is part of the accessible name:
                                  // two tools can share a title within a connector.
                                  aria-label={`${tool.label} (${tool.name}) — ${label}`}
                                  checked={current === rule}
                                  onChange={() => update(withRule(prefs, tool.name, rule))}
                                />
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          );
        })}
        {unlisted.length > 0 ? (
          <p className="px-1 pt-1 text-xs text-gray-500 dark:text-gray-400">
            Also decided, for tools not offered to you right now:{' '}
            {unlisted.map((name, index) => (
              <span key={name}>
                {index > 0 ? ', ' : ''}
                <code className="font-mono">{name}</code>
                {prefs.alwaysDeny.includes(name) ? ' (blocked)' : ' (allowed)'}
                <button
                  type="button"
                  onClick={() => update(withRule(prefs, name, 'ask'))}
                  className="ml-1 text-blue-600 hover:underline dark:text-blue-400"
                >
                  ask again
                </button>
              </span>
            ))}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 px-4 py-3 dark:border-gray-800">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving' || !dirty}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">Could not save.</span>
        ) : null}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Applies from the next message you send, in every chat of yours.
        </p>
      </div>
    </section>
  );
}
