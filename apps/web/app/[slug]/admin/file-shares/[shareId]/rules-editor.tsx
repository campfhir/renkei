'use client';

/**
 * The rules navigator: browse the REAL share (the operator-only unfiltered
 * listing), click a file or folder to select it, and set below what
 * everyone — or one granted person — may do at that exact path. Selection
 * beats typing paths; the panel edits rules, and everything downstream
 * (files page, MCP tools, worker enforcement) follows the store.
 *
 * The permission math shown here is the REAL engine: the pure helpers from
 * the connector package compute each row's inherited value (share layer at
 * the path, min'd with the person's own layer), so the label beside
 * "inherit" is exactly what the worker would enforce. Setting a value
 * upserts a rule at the selected path; choosing inherit deletes it.
 *
 * A collapsed "All rules" list keeps the one thing browsing cannot reach —
 * rules anchored on paths that no longer exist — plus add-by-path for
 * folders yet to be created.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getJson, sendJson } from '@/lib/fetch-json';
import { layerAccess, minAccess } from '@renkei/connector-fileshares/pure';
import type { PathRule } from '@renkei/connector-fileshares/pure';
import { Icon, ICONS } from '@/components/icons';
import { inputClass, pathPreview } from '../share-config-fields';

type Access = 'none' | 'read' | 'read_write';

interface BrowseEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number | null;
}

interface RuleRowView {
  id: string;
  subject: string | null;
  path: string;
  access: Access;
}

interface GrantRowView {
  subject: string;
  defaultAccess: Access;
}

interface Selected {
  name: string;
  path: string;
  kind: 'file' | 'dir';
}

const ACCESS_LABEL: Record<Access, string> = {
  none: 'no access',
  read: 'read',
  read_write: 'read/write',
};

export default function RulesEditor({
  slug,
  shareId,
  people,
  share,
}: {
  slug: string;
  shareId: string;
  people: { subject: string; label: string }[];
  share: { maxAccess: 'read' | 'read_write'; caseInsensitive: boolean };
}) {
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [rules, setRules] = useState<RuleRowView[]>([]);
  const [grants, setGrants] = useState<GrantRowView[]>([]);
  const [selected, setSelected] = useState<Selected>({ name: 'Share root', path: '/', kind: 'dir' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rulePath, setRulePath] = useState('');
  const [ruleSubject, setRuleSubject] = useState('');
  const [ruleAccess, setRuleAccess] = useState<Access>('read');

  const base = `/api/admin/${slug}/file-shares/${shareId}`;
  const fold = useCallback(
    (value: string) => (share.caseInsensitive ? value.toLowerCase() : value),
    [share.caseInsensitive]
  );
  const labelFor = (subject: string) =>
    people.find((person) => person.subject === subject)?.label ?? subject;

  const loadRules = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ rules: RuleRowView[] }>(
      `${base}/rules?all=1`
    );
    if (loadError || !data) setError(loadError ?? 'Could not load rules');
    else setRules(data.rules);
  }, [base]);

  const loadGrants = useCallback(async () => {
    const { data, error: loadError } = await getJson<{ grants: GrantRowView[] }>(`${base}/grants`);
    if (loadError || !data) setError(loadError ?? 'Could not load grants');
    else setGrants(data.grants);
  }, [base]);

  const loadBrowse = useCallback(
    async (browsePath: string) => {
      setLoading(true);
      setError(null);
      const { data, error: loadError } = await getJson<{ entries: BrowseEntry[] }>(
        `${base}/browse?path=${encodeURIComponent(browsePath)}`
      );
      setLoading(false);
      if (loadError || !data) {
        setError(loadError ?? 'Could not open the folder');
        setEntries([]);
        return;
      }
      setEntries(data.entries);
    },
    [base]
  );

  useEffect(() => {
    void loadRules();
    void loadGrants();
  }, [loadRules, loadGrants]);
  useEffect(() => {
    void loadBrowse(path);
  }, [path, loadBrowse]);

  /** Navigate into a folder; the navigated folder becomes the selection. */
  const navigate = (folderPath: string) => {
    setPath(folderPath);
    setSelected({
      name: folderPath === '/' ? 'Share root' : folderPath.slice(folderPath.lastIndexOf('/') + 1),
      path: folderPath,
      kind: 'dir',
    });
  };

  const shareRules = useMemo<PathRule[]>(
    () => rules.filter((rule) => rule.subject === null).map((rule) => ({ path: rule.path, access: rule.access })),
    [rules]
  );
  const rulesFor = useCallback(
    (subject: string): PathRule[] =>
      rules
        .filter((rule) => rule.subject === subject)
        .map((rule) => ({ path: rule.path, access: rule.access })),
    [rules]
  );
  const exactRule = (subject: string | null, targetPath: string) =>
    rules.find(
      (rule) => (rule.subject ?? null) === subject && fold(rule.path) === fold(targetPath)
    );
  const pathHasAnyRule = (targetPath: string) =>
    rules.some((rule) => fold(rule.path) === fold(targetPath));

  /** The share layer's value at a path, explicit rules included. */
  const shareValueAt = useCallback(
    (targetPath: string): Access =>
      layerAccess(shareRules, targetPath, share.maxAccess, share.caseInsensitive),
    [shareRules, share.maxAccess, share.caseInsensitive]
  );

  /** What a layer would say at the path WITHOUT its exact rule there — the "inherit" value. */
  const withoutExact = (layer: PathRule[], targetPath: string): PathRule[] =>
    layer.filter((rule) => fold(rule.path) !== fold(targetPath));

  const setRule = async (subject: string | null, targetPath: string, value: Access | 'inherit') => {
    setError(null);
    if (value === 'inherit') {
      const rule = exactRule(subject, targetPath);
      if (!rule) return;
      const deleteError = await sendJson(`${base}/rules/${rule.id}`, 'DELETE');
      if (deleteError) setError(deleteError);
    } else {
      const saveError = await sendJson(`${base}/rules`, 'POST', {
        subject: subject ?? undefined,
        path: targetPath,
        access: value,
      });
      if (saveError) setError(saveError);
    }
    await loadRules();
  };

  const crumbs = path === '/' ? [] : path.slice(1).split('/');
  const rulePreview = pathPreview(rulePath || '/');
  const selectedShareValue = shareValueAt(selected.path);

  const accessSelect = (
    value: Access | 'inherit',
    inheritedLabel: string,
    onChange: (value: Access | 'inherit') => void
  ) => (
    <select
      className={inputClass}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        if (next === 'inherit' || next === 'none' || next === 'read' || next === 'read_write') {
          onChange(next);
        }
      }}
    >
      <option value="inherit">inherit ({inheritedLabel})</option>
      <option value="none">no access</option>
      <option value="read">read</option>
      <option value="read_write">read/write</option>
    </select>
  );

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-800">
      {/* ── The navigator: breadcrumb + scrollable listing ─────────────── */}
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 p-3 text-sm dark:border-gray-800">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="font-mono text-blue-600 hover:underline dark:text-blue-400"
        >
          /
        </button>
        {crumbs.map((crumb, index) => (
          <span key={`${crumb}-${index}`} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => navigate('/' + crumbs.slice(0, index + 1).join('/'))}
              className="font-mono text-blue-600 hover:underline dark:text-blue-400"
            >
              {crumb}
            </button>
            {index < crumbs.length - 1 ? <span className="text-gray-400">/</span> : null}
          </span>
        ))}
        {loading ? <span className="ml-2 text-xs text-gray-400">Loading…</span> : null}
      </div>

      <ul className="max-h-72 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-900">
        {!loading && entries.length === 0 && !error ? (
          <li className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
            This folder is empty.
          </li>
        ) : null}
        {entries.map((entry) => {
          const isSelected = fold(selected.path) === fold(entry.path);
          return (
            <li key={entry.path} className="flex items-center">
              <button
                type="button"
                onClick={() => setSelected({ name: entry.name, path: entry.path, kind: entry.kind })}
                className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  isSelected
                    ? 'bg-blue-50 dark:bg-blue-950/30'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-900'
                }`}
              >
                <span
                  className={`min-w-0 truncate ${
                    entry.kind === 'dir' ? 'font-medium text-blue-600 dark:text-blue-400' : ''
                  }`}
                >
                  {entry.name}
                  {entry.kind === 'dir' ? '/' : ''}
                </span>
                {pathHasAnyRule(entry.path) ? (
                  <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">rule</span>
                ) : null}
                <span className="min-w-0 flex-1" />
              </button>
              {entry.kind === 'dir' ? (
                <button
                  type="button"
                  aria-label={`Open ${entry.name}`}
                  onClick={() => navigate(entry.path)}
                  className={`shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200 ${
                    isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : ''
                  }`}
                >
                  <Icon path={ICONS.chevron} />
                </button>
              ) : (
                <span className="w-7 shrink-0" />
              )}
            </li>
          );
        })}
      </ul>

      {/* ── The permissions panel for the selection ────────────────────── */}
      <div className="border-t border-gray-200 p-3 dark:border-gray-800">
        <p className="text-sm font-semibold">
          {selected.name}
          {selected.kind === 'dir' && selected.path !== '/' ? '/' : ''} permissions
        </p>
        <p className="mb-2 font-mono text-xs text-gray-500 dark:text-gray-400">{selected.path}</p>

        <ul className="max-h-56 space-y-2 overflow-y-auto text-sm">
          <li className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              Everyone granted
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                share-wide ceiling
              </span>
            </span>
            {accessSelect(
              exactRule(null, selected.path)?.access ?? 'inherit',
              ACCESS_LABEL[
                layerAccess(
                  withoutExact(shareRules, selected.path),
                  selected.path,
                  share.maxAccess,
                  share.caseInsensitive
                )
              ],
              (value) => void setRule(null, selected.path, value)
            )}
          </li>
          {grants.map((grant) => {
            const explicit = exactRule(grant.subject, selected.path);
            const inherited = minAccess(
              selectedShareValue,
              layerAccess(
                withoutExact(rulesFor(grant.subject), selected.path),
                selected.path,
                grant.defaultAccess,
                share.caseInsensitive
              )
            );
            const capped =
              explicit && minAccess(selectedShareValue, explicit.access) !== explicit.access;
            return (
              <li key={grant.subject} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {labelFor(grant.subject)}
                  {capped ? (
                    <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                      capped to {ACCESS_LABEL[selectedShareValue]} by share-wide rules
                    </span>
                  ) : null}
                </span>
                {accessSelect(explicit?.access ?? 'inherit', ACCESS_LABEL[inherited], (value) =>
                  void setRule(grant.subject, selected.path, value)
                )}
              </li>
            );
          })}
          {grants.length === 0 ? (
            <li className="text-sm text-gray-500 dark:text-gray-400">
              No one is granted yet — add people under Access above, then set their limits here.
            </li>
          ) : null}
        </ul>
      </div>

      {/* ── The audit list: every rule, reachable even off the filesystem ─ */}
      <details className="border-t border-gray-200 p-3 dark:border-gray-800">
        <summary className="cursor-pointer text-sm font-medium">
          All rules ({rules.length})
        </summary>
        <ul className="mt-2 space-y-2 text-sm">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-gray-600 dark:text-gray-400">
                {rule.subject === null ? 'Everyone' : labelFor(rule.subject)}
              </span>
              <span className="min-w-0 truncate font-mono text-xs">{rule.path}</span>
              <span className="ml-auto flex items-center gap-2">
                <select
                  className={inputClass}
                  value={rule.access}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (next === 'none' || next === 'read' || next === 'read_write') {
                      void setRule(rule.subject, rule.path, next);
                    }
                  }}
                >
                  <option value="none">no access</option>
                  <option value="read">read</option>
                  <option value="read_write">read/write</option>
                </select>
                <button
                  type="button"
                  onClick={() => void setRule(rule.subject, rule.path, 'inherit')}
                  className="text-sm text-red-600 hover:underline dark:text-red-400"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
          {rules.length === 0 ? (
            <li className="text-sm text-gray-500 dark:text-gray-400">No rules yet.</li>
          ) : null}
        </ul>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
          <input
            value={rulePath}
            onChange={(event) => setRulePath(event.target.value)}
            placeholder="/folder/subfolder — or paste \\server\share\folder"
            className={`${inputClass} min-w-56 flex-1`}
          />
          <select
            aria-label="Rule layer"
            className={inputClass}
            value={ruleSubject}
            onChange={(event) => setRuleSubject(event.target.value)}
          >
            <option value="">Everyone granted</option>
            {grants.map((grant) => (
              <option key={grant.subject} value={grant.subject}>
                Only: {labelFor(grant.subject)}
              </option>
            ))}
          </select>
          <select
            aria-label="Rule access"
            className={inputClass}
            value={ruleAccess}
            onChange={(event) => {
              const next = event.target.value;
              if (next === 'none' || next === 'read' || next === 'read_write') setRuleAccess(next);
            }}
          >
            <option value="none">no access</option>
            <option value="read">read</option>
            <option value="read_write">read/write</option>
          </select>
          <button
            type="button"
            disabled={!rulePath.trim() || rulePreview.error}
            onClick={() => {
              void setRule(ruleSubject || null, rulePath, ruleAccess);
              setRulePath('');
            }}
            className="text-sm font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
          >
            + Add rule
          </button>
          <span
            className={`w-full text-xs ${
              rulePreview.error ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {rulePath.trim() ? rulePreview.text : 'Rules may name folders that do not exist yet.'}
          </span>
        </div>
      </details>

      {error ? (
        <p className="border-t border-gray-200 p-3 text-sm text-red-600 dark:border-gray-800 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
