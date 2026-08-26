'use client';

/**
 * The permissions navigator: browse the REAL share (the operator-only
 * unfiltered listing), click a file or folder to select it, and set below
 * what everyone — or one granted person — may do at that exact path.
 * Selection beats typing paths, and the search box on top jumps anywhere
 * on the share (a bounded tree walk in the fileshare worker) regardless
 * of what is currently rendered.
 *
 * Permissions are two checkboxes, read and write, backed by the same
 * three-level rules the engine enforces: neither = no access, read = read,
 * both = read/write. What renders is the EFFECTIVE state at the selected
 * path (explicit rule or inherited — computed with the connector's pure
 * helpers, exactly what the worker enforces); toggling writes an explicit
 * rule, and the trash icon on an explicit row deletes it back to inherit.
 * Ceilings gray boxes out: a person cannot hold or be granted write where
 * the layer above allows only read.
 *
 * Below the panel, a flat list shows every explicit permission anchored at
 * or under the folder being browsed — at the share root that is every rule
 * on the share, which also keeps rules on paths that no longer exist on
 * disk reachable and removable.
 *
 * People join the share from here too: Add user picks from the org
 * directory (selection only — subject identifiers are never typed) and
 * creates the grant; grant changes are announced on GRANTS_CHANGED_EVENT
 * so the Access section above stays in sync.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getJson, sendJson } from '@/lib/fetch-json';
import {
  isBoundaryPrefix,
  layerAccess,
  minAccess,
  parentPath,
} from '@renkei/connector-fileshares/pure';
import type { PathRule } from '@renkei/connector-fileshares/pure';
import { Icon, ICONS } from '@/components/icons';
import Modal from '@/components/modal';
import { useDismiss } from '@/lib/use-dismiss';
import { inputClass } from '../share-config-fields';
import { GRANTS_CHANGED_EVENT } from './grant-manager';

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

interface SearchHitView {
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
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHitView[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [userFilter, setUserFilter] = useState('');
  const searchRef = useRef<HTMLDivElement | null>(null);
  useDismiss(searchOpen, searchRef, () => setSearchOpen(false));

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
    // Grant edits from either surface (the Access section above, or this
    // panel's Add user) announce themselves; a removal also cascades that
    // person's rules, so both reload together.
    const onChanged = () => {
      void loadGrants();
      void loadRules();
    };
    window.addEventListener(GRANTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(GRANTS_CHANGED_EVENT, onChanged);
  }, [loadRules, loadGrants]);
  useEffect(() => {
    void loadBrowse(path);
  }, [path, loadBrowse]);

  // The jump-anywhere search: debounced, share-wide, independent of what
  // the navigator currently renders.
  useEffect(() => {
    if (searchQ.trim().length < 2) {
      setSearchResults([]);
      setSearchOpen(false);
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        setSearching(true);
        const { data, error: searchError } = await getJson<{
          results: SearchHitView[];
          truncated: boolean;
        }>(`${base}/search?q=${encodeURIComponent(searchQ.trim())}`);
        setSearching(false);
        if (!searchError && data) {
          setSearchResults(data.results);
          setSearchTruncated(data.truncated);
        }
        setSearchOpen(true);
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQ, base]);

  /** Land on a search hit: its parent becomes the folder, the hit the selection. */
  const goToHit = (hit: SearchHitView) => {
    setPath(parentPath(hit.path));
    setSelected({ name: hit.name, path: hit.path, kind: hit.kind });
    setSearchOpen(false);
    setSearchQ('');
  };

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
    // Optimistic: checkboxes must answer the click immediately; the reload
    // below reconciles with what the server actually stored.
    if (value === 'inherit') {
      const rule = exactRule(subject, targetPath);
      if (!rule) return;
      setRules((current) => current.filter((row) => row.id !== rule.id));
      const deleteError = await sendJson(`${base}/rules/${rule.id}`, 'DELETE');
      if (deleteError) setError(deleteError);
    } else {
      setRules((current) => {
        const existing = current.find(
          (row) => (row.subject ?? null) === subject && fold(row.path) === fold(targetPath)
        );
        if (existing) {
          return current.map((row) =>
            row.id === existing.id ? { ...row, access: value } : row
          );
        }
        return [
          ...current,
          { id: `optimistic:${subject ?? ''}:${targetPath}`, subject, path: targetPath, access: value },
        ];
      });
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
  const selectedShareValue = shareValueAt(selected.path);
  /** Every explicit rule anchored at or under the folder being browsed. */
  const nestedRules = rules.filter((rule) =>
    isBoundaryPrefix(path, rule.path, share.caseInsensitive)
  );

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-800">
      {/* ── Jump anywhere on the share ─────────────────────────────────── */}
      <div ref={searchRef} className="relative border-b border-gray-200 p-3 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <Icon path={ICONS.search} className="h-4 w-4 shrink-0 text-gray-400" />
          <input
            aria-label="Search the share"
            placeholder="Search the whole share — e.g. /it/policies"
            className={`${inputClass} w-full`}
            value={searchQ}
            onChange={(event) => setSearchQ(event.target.value)}
            onFocus={() => {
              if (searchQ.trim().length >= 2) setSearchOpen(true);
            }}
          />
        </div>
        {searchOpen ? (
          <div className="absolute left-3 right-3 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-950">
            {searching ? (
              <p className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400">Searching…</p>
            ) : searchResults.length === 0 ? (
              <p className="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400">No matches.</p>
            ) : (
              searchResults.map((hit) => (
                <button
                  key={hit.path}
                  type="button"
                  onClick={() => goToHit(hit)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <span
                    className={`min-w-0 truncate ${
                      hit.kind === 'dir' ? 'font-medium text-blue-600 dark:text-blue-400' : ''
                    }`}
                  >
                    {hit.name}
                    {hit.kind === 'dir' ? '/' : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-gray-500 dark:text-gray-400">
                    {parentPath(hit.path) === '/' ? 'Share root' : parentPath(hit.path).slice(1)}
                  </span>
                </button>
              ))
            )}
            {!searching && searchTruncated ? (
              <p className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500">
                Large share — not everything was searched. A more specific query narrows it.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

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
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">
            {selected.name}
            {selected.kind === 'dir' && selected.path !== '/' ? '/' : ''} permissions
          </p>
          {grants.length > 0 ? (
            <input
              aria-label="Filter people"
              placeholder="Filter people…"
              className={`${inputClass} w-40`}
              value={userFilter}
              onChange={(event) => setUserFilter(event.target.value)}
            />
          ) : null}
        </div>

        <ul className="max-h-56 space-y-2 overflow-y-auto text-sm">
          <li className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              Everyone granted
              <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                share-wide ceiling
              </span>
            </span>
            <PermissionCheckboxes
              name="Everyone granted"
              level={selectedShareValue}
              ceiling={share.maxAccess}
              explicit={Boolean(exactRule(null, selected.path))}
              onLevel={(next) => void setRule(null, selected.path, next)}
              onClear={() => void setRule(null, selected.path, 'inherit')}
            />
          </li>
          {grants
            .filter((grant) => {
              const needle = userFilter.trim().toLowerCase();
              if (!needle) return true;
              return (
                labelFor(grant.subject).toLowerCase().includes(needle) ||
                grant.subject.toLowerCase().includes(needle)
              );
            })
            .map((grant) => {
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
                        capped to {ACCESS_LABEL[selectedShareValue]} by the level above
                      </span>
                    ) : null}
                  </span>
                  <PermissionCheckboxes
                    name={labelFor(grant.subject)}
                    level={explicit?.access ?? inherited}
                    ceiling={selectedShareValue}
                    explicit={Boolean(explicit)}
                    onLevel={(next) => void setRule(grant.subject, selected.path, next)}
                    onClear={() => void setRule(grant.subject, selected.path, 'inherit')}
                  />
                </li>
              );
            })}
          {grants.length === 0 ? (
            <li className="text-sm text-gray-500 dark:text-gray-400">
              No one is granted yet — Add user below puts someone on this share.
            </li>
          ) : null}
        </ul>
        <button
          type="button"
          onClick={() => setAddUserOpen(true)}
          className="mt-3 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          + Add user
        </button>
      </div>

      {addUserOpen ? (
        <AddUserModal
          slug={slug}
          shareId={shareId}
          people={people.filter(
            (person) => !grants.some((grant) => grant.subject === person.subject)
          )}
          onClose={() => setAddUserOpen(false)}
        />
      ) : null}

      {/* ── Every permission set at or under this folder, flat ──────────── */}
      {nestedRules.length > 0 ? (
        <div className="border-t border-gray-200 p-3 dark:border-gray-800">
          <p className="mb-2 text-sm font-semibold">Permissions in this folder</p>
          <ul className="space-y-2 text-sm">
            {nestedRules.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate">
                  {rule.subject === null ? 'Everyone granted' : labelFor(rule.subject)}
                </span>
                <span className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">
                  {rule.path === '/' ? 'Share root' : rule.path.slice(1)}
                </span>
                <span className="ml-auto">
                  <PermissionCheckboxes
                    name={`${rule.subject === null ? 'Everyone granted' : labelFor(rule.subject)} at ${rule.path}`}
                    level={rule.access}
                    ceiling="read_write"
                    explicit
                    onLevel={(next) => void setRule(rule.subject, rule.path, next)}
                    onClear={() => void setRule(rule.subject, rule.path, 'inherit')}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p className="border-t border-gray-200 p-3 text-sm text-red-600 dark:border-gray-800 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Two checkboxes over the three-level ladder: neither = no access, read =
 * read, both = read/write (checking write implies read; unchecking read
 * clears write with it). `ceiling` grays out what the layer above does not
 * allow — a box you cannot check because nobody below that level may hold
 * it here. `explicit` rows carry the trash icon that deletes the rule
 * (back to inherited); inherited rows say so.
 */
function PermissionCheckboxes({
  name,
  level,
  ceiling,
  explicit,
  onLevel,
  onClear,
}: {
  name: string;
  level: Access;
  ceiling: Access;
  explicit: boolean;
  onLevel: (next: Access) => void;
  onClear: () => void;
}) {
  const readChecked = level !== 'none';
  const writeChecked = level === 'read_write';
  const readDisabled = ceiling === 'none';
  const writeDisabled = ceiling !== 'read_write';

  const box = (
    label: 'read' | 'write',
    checked: boolean,
    disabled: boolean,
    onToggle: (checked: boolean) => void
  ) => (
    <label
      className={`flex items-center gap-1 text-xs ${
        disabled ? 'opacity-40' : 'cursor-pointer'
      } text-gray-600 dark:text-gray-400`}
    >
      <input
        type="checkbox"
        aria-label={`${name}: ${label}`}
        className="h-4 w-4 accent-blue-600"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onToggle(event.target.checked)}
      />
      {label}
    </label>
  );

  return (
    <span className="flex shrink-0 items-center gap-3">
      {!explicit ? (
        <span className="text-xs text-gray-400 dark:text-gray-500">inherited</span>
      ) : null}
      {box('read', readChecked, readDisabled, (checked) => onLevel(checked ? 'read' : 'none'))}
      {box('write', writeChecked, writeDisabled, (checked) =>
        onLevel(checked ? 'read_write' : 'read')
      )}
      {explicit ? (
        <button
          type="button"
          aria-label={`Remove the permission set for ${name}`}
          onClick={onClear}
          className="rounded-md p-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          <Icon path={ICONS.trash} className="h-4 w-4" />
        </button>
      ) : (
        <span className="w-6" />
      )}
    </span>
  );
}

/**
 * Put a person on the share from the org directory — selection only, no
 * pasted subject identifiers. Adding here creates their GRANT (the panel
 * lists grantees); their per-path limits are then set by selection above.
 */
function AddUserModal({
  slug,
  shareId,
  people,
  onClose,
}: {
  slug: string;
  shareId: string;
  people: { subject: string; label: string }[];
  onClose: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [level, setLevel] = useState<Access>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!subject) return;
    setBusy(true);
    setError(null);
    const saveError = await sendJson(`/api/admin/${slug}/file-shares/${shareId}/grants`, 'POST', {
      subject,
      defaultAccess: level,
    });
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    window.dispatchEvent(new CustomEvent(GRANTS_CHANGED_EVENT));
    onClose();
  };

  return (
    <Modal title="Add user" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block text-gray-600 dark:text-gray-400">Person</span>
          <select
            autoFocus
            className={`${inputClass} w-full`}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          >
            <option value="">Pick a person…</option>
            {people.map((person) => (
              <option key={person.subject} value={person.subject}>
                {person.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-gray-600 dark:text-gray-400">
            Access across the share
          </span>
          <select
            className={`${inputClass} w-full`}
            value={level}
            onChange={(event) => {
              const next = event.target.value;
              if (next === 'none' || next === 'read' || next === 'read_write') setLevel(next);
            }}
          >
            <option value="none">specific folders only</option>
            <option value="read">read</option>
            <option value="read_write">read/write</option>
          </select>
        </label>
        {people.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400">
            Everyone the org knows about already has access to this share.
          </p>
        ) : null}
        {error ? <p className="text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-900"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!subject || busy}
            onClick={() => void add()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add user'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
