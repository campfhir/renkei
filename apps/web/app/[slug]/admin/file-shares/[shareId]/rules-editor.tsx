'use client';

/**
 * The two-layer rules editor. A layer switch picks the share-wide layer or
 * one person's; two modes edit it:
 *
 *  - Browse: drill down the real folder tree (the operator-only browse
 *    route, which lists over the service credential), each row showing the
 *    layer's computed access — dimmed when inherited from above, solid
 *    when an explicit rule sits on the row — with set/clear controls
 *    in place. The SitePicker idiom: per-level loading, error and empty
 *    states, breadcrumb back-navigation.
 *  - Rules: the layer's raw rule list plus an add form, for paths that do
 *    not exist yet. Windows spellings translate live.
 *
 * An allow rule under a closed folder still works (longest path wins);
 * the deny only closes what it covers more specifically.
 */

import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson } from '@/lib/fetch-json';
import { inputClass, pathPreview } from '../share-config-fields';

type Access = 'none' | 'read' | 'read_write';

interface BrowseEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number | null;
  access: Access;
  explicit: boolean;
}

interface RuleRowView {
  id: string;
  subject: string | null;
  path: string;
  access: Access;
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
}: {
  slug: string;
  shareId: string;
  people: { subject: string; label: string }[];
}) {
  const [layerSubject, setLayerSubject] = useState<string>('');
  const [mode, setMode] = useState<'browse' | 'rules'>('browse');
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [layerDefault, setLayerDefault] = useState<Access>('read');
  const [rules, setRules] = useState<RuleRowView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rulePath, setRulePath] = useState('');
  const [ruleAccess, setRuleAccess] = useState<Access>('read');

  const layerQuery = layerSubject ? `&subject=${encodeURIComponent(layerSubject)}` : '';

  const loadBrowse = useCallback(
    async (browsePath: string) => {
      setLoading(true);
      setError(null);
      const { data, error: loadError } = await getJson<{
        entries: BrowseEntry[];
        layerDefault: Access;
      }>(
        `/api/admin/${slug}/file-shares/${shareId}/browse?path=${encodeURIComponent(browsePath)}${layerQuery}`
      );
      setLoading(false);
      if (loadError || !data) {
        setError(loadError ?? 'Could not browse');
        setEntries([]);
        return;
      }
      setEntries(data.entries);
      setLayerDefault(data.layerDefault);
    },
    [slug, shareId, layerQuery]
  );

  const loadRules = useCallback(async () => {
    setError(null);
    const { data, error: loadError } = await getJson<{ rules: RuleRowView[] }>(
      `/api/admin/${slug}/file-shares/${shareId}/rules?${layerQuery.replace(/^&/, '')}`
    );
    if (loadError || !data) {
      setError(loadError ?? 'Could not load rules');
      return;
    }
    setRules(data.rules);
  }, [slug, shareId, layerQuery]);

  useEffect(() => {
    setPath('/');
    void loadRules();
    if (mode === 'browse') void loadBrowse('/');
  }, [layerSubject]);

  useEffect(() => {
    if (mode === 'browse') void loadBrowse(path);
    else void loadRules();
  }, [mode, path]);

  const setRule = async (targetPath: string, access: Access | 'clear') => {
    setError(null);
    if (access === 'clear') {
      const rule = rules.find(
        (row) => row.path === targetPath && (row.subject ?? '') === layerSubject
      );
      if (!rule) return;
      const removeError = await sendJson(
        `/api/admin/${slug}/file-shares/${shareId}/rules/${rule.id}`,
        'DELETE'
      );
      if (removeError) {
        setError(removeError);
        return;
      }
    } else {
      const saveError = await sendJson(`/api/admin/${slug}/file-shares/${shareId}/rules`, 'POST', {
        subject: layerSubject || undefined,
        path: targetPath,
        access,
      });
      if (saveError) {
        setError(saveError);
        return;
      }
    }
    await loadRules();
    if (mode === 'browse') await loadBrowse(path);
  };

  const crumbs = path === '/' ? [] : path.slice(1).split('/');
  const rulePreview = pathPreview(rulePath || '/');

  return (
    <div className="rounded-md border border-gray-200 p-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Rule layer"
          className={inputClass}
          value={layerSubject}
          onChange={(event) => setLayerSubject(event.target.value)}
        >
          <option value="">Share-wide (everyone granted)</option>
          {people.map((person) => (
            <option key={person.subject} value={person.subject}>
              Only: {person.label}
            </option>
          ))}
        </select>
        <div className="ml-auto flex rounded-md border border-gray-300 text-sm dark:border-gray-700">
          <button
            type="button"
            onClick={() => setMode('browse')}
            className={`px-3 py-1 ${mode === 'browse' ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-900'} rounded-l-md`}
          >
            Browse
          </button>
          <button
            type="button"
            onClick={() => setMode('rules')}
            className={`px-3 py-1 ${mode === 'rules' ? 'bg-blue-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-900'} rounded-r-md`}
          >
            Rules ({rules.length})
          </button>
        </div>
      </div>

      {layerSubject && !rules.length ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          This person&apos;s layer has no rules — their grant default applies everywhere.
        </p>
      ) : null}

      {mode === 'browse' ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-1 text-sm">
            <button
              type="button"
              onClick={() => setPath('/')}
              className="font-mono text-blue-600 hover:underline dark:text-blue-400"
            >
              /
            </button>
            {crumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPath('/' + crumbs.slice(0, index + 1).join('/'))}
                  className="font-mono text-blue-600 hover:underline dark:text-blue-400"
                >
                  {crumb}
                </button>
                {index < crumbs.length - 1 ? <span className="text-gray-400">/</span> : null}
              </span>
            ))}
            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
              inherited here: {ACCESS_LABEL[layerDefault]}
            </span>
          </div>

          {loading ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
          ) : entries.length === 0 && !error ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">This folder is empty.</p>
          ) : (
            <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-900">
              {entries.map((entry) => (
                <li key={entry.path} className="flex items-center justify-between gap-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    {entry.kind === 'dir' ? (
                      <button
                        type="button"
                        onClick={() => setPath(entry.path)}
                        className="truncate text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {entry.name}/
                      </button>
                    ) : (
                      <span className="truncate text-sm">{entry.name}</span>
                    )}
                  </div>
                  <span
                    className={`shrink-0 text-xs ${entry.explicit ? 'font-semibold' : 'text-gray-400 dark:text-gray-500'}`}
                  >
                    {entry.explicit ? 'rule: ' : 'inherited: '}
                    {ACCESS_LABEL[entry.access]}
                  </span>
                  <select
                    aria-label={`Access for ${entry.path}`}
                    className={`${inputClass} shrink-0 py-0.5 text-xs`}
                    value={entry.explicit ? entry.access : 'inherit'}
                    onChange={(event) =>
                      void setRule(
                        entry.path,
                        event.target.value === 'inherit'
                          ? 'clear'
                          : event.target.value === 'read_write'
                            ? 'read_write'
                            : event.target.value === 'read'
                              ? 'read'
                              : 'none'
                      )
                    }
                  >
                    <option value="inherit">inherit</option>
                    <option value="none">no access</option>
                    <option value="read">read</option>
                    <option value="read_write">read/write</option>
                  </select>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-3">
          {rules.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No rules in this layer — its default applies to the whole tree.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-900">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">{rule.path}</span>
                  <select
                    aria-label={`Access for ${rule.path}`}
                    className={`${inputClass} shrink-0 py-0.5 text-xs`}
                    value={rule.access}
                    onChange={(event) =>
                      void setRule(
                        rule.path,
                        event.target.value === 'read_write'
                          ? 'read_write'
                          : event.target.value === 'read'
                            ? 'read'
                            : 'none'
                      )
                    }
                  >
                    <option value="none">no access</option>
                    <option value="read">read</option>
                    <option value="read_write">read/write</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => void setRule(rule.path, 'clear')}
                    className="shrink-0 text-sm text-red-600 hover:underline dark:text-red-400"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
            <input
              aria-label="Rule path"
              className={`${inputClass} min-w-64 flex-1`}
              placeholder="/folder/subfolder — or paste \\server\share\folder"
              value={rulePath}
              onChange={(event) => setRulePath(event.target.value)}
            />
            <select
              aria-label="Rule access"
              className={inputClass}
              value={ruleAccess}
              onChange={(event) =>
                setRuleAccess(
                  event.target.value === 'read_write'
                    ? 'read_write'
                    : event.target.value === 'read'
                      ? 'read'
                      : 'none'
                )
              }
            >
              <option value="none">no access</option>
              <option value="read">read</option>
              <option value="read_write">read/write</option>
            </select>
            <button
              type="button"
              disabled={!rulePath.trim() || rulePreview.error}
              onClick={() => {
                void setRule(rulePath, ruleAccess);
                setRulePath('');
              }}
              className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400 disabled:opacity-50"
            >
              + Add rule
            </button>
            <span
              className={`w-full text-xs ${rulePreview.error ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
            >
              {rulePath ? rulePreview.text : 'Rules may name folders that do not exist yet.'}
            </span>
          </div>
        </div>
      )}

      {error ? <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
