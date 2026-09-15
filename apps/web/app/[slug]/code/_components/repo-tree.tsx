'use client';

/**
 * The repository's folders and files as a tree, one directory fetched as
 * it is opened (`…/code/projects/[id]/tree?path=`), directories first —
 * from the checkout on the sandbox once a chat has made one, and from
 * Bitbucket on the project's branch before that, so the shape of the
 * repository is there to look at without cloning anything. A look, not a
 * workbench: the chat's tools are what read and change it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { getJson } from '@/lib/fetch-json';
import { LoadingLine } from '@/components/skeleton';

interface Entry {
  path: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  sizeBytes: number | null;
}

type Listing =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; entries: Entry[] };

type Source = 'checkout' | 'bitbucket';

function nameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function size(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

export default function RepoTree({ tenantId, projectId }: { tenantId: string; projectId: string }) {
  const base = `/api/tenant/${tenantId}/code/projects/${projectId}/tree`;
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [source, setSource] = useState<Source | null>(null);
  const [branch, setBranch] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      setListings((current) => ({ ...current, [path]: { state: 'loading' } }));
      const result = await getJson<{
        path: string;
        entries: Entry[];
        source: Source;
        branch: string;
      }>(`${base}?path=${encodeURIComponent(path)}`);
      if (result.data) {
        setSource(result.data.source);
        setBranch(result.data.branch);
      }
      setListings((current) => ({
        ...current,
        [path]: result.data
          ? { state: 'ready', entries: result.data.entries }
          : { state: 'error', message: result.error ?? 'Could not list the folder.' },
      }));
    },
    [base]
  );

  useEffect(() => {
    void load('');
  }, [load]);

  const toggle = (path: string) => {
    const next = !open[path];
    setOpen((current) => ({ ...current, [path]: next }));
    if (next && !listings[path]) void load(path);
  };

  const renderDir = (path: string, depth: number) => {
    const listing = listings[path];
    if (!listing || listing.state === 'loading') {
      return (
        <li className="py-1 pl-2">
          <LoadingLine size="xs" />
        </li>
      );
    }
    if (listing.state === 'error') {
      return (
        <li className="py-1 pl-2 text-xs text-red-600 dark:text-red-400">{listing.message}</li>
      );
    }
    if (listing.entries.length === 0) {
      return <li className="py-1 pl-2 text-xs text-gray-400">Empty.</li>;
    }
    return listing.entries.map((entry) => {
      const name = nameOf(entry.path);
      const indent = { paddingLeft: `${depth * 12 + 4}px` };
      if (entry.kind === 'dir') {
        const expanded = open[entry.path] === true;
        return (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => toggle(entry.path)}
              aria-expanded={expanded}
              style={indent}
              className="flex w-full items-center gap-1.5 rounded py-0.5 pr-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-900"
            >
              <Icon
                path={ICONS.chevron}
                className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
              />
              <Icon path={ICONS.folder} className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span className="truncate">{name}</span>
            </button>
            {expanded ? <ul>{renderDir(entry.path, depth + 1)}</ul> : null}
          </li>
        );
      }
      return (
        <li
          key={entry.path}
          style={indent}
          className="flex items-center gap-1.5 py-0.5 pr-2 text-xs text-gray-700 dark:text-gray-300"
          title={entry.path}
        >
          <span className="inline-block h-3 w-3 shrink-0" />
          <Icon path={ICONS.file} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <span className="min-w-0 flex-1 truncate">
            {name}
            {entry.kind === 'link' ? ' →' : ''}
          </span>
          {entry.sizeBytes !== null ? (
            <span className="shrink-0 text-[10px] text-gray-400">{size(entry.sizeBytes)}</span>
          ) : null}
        </li>
      );
    });
  };

  // The branch the tree shows: the checkout's working branch once a chat
  // has cloned; before that the branch the project was pointed at, as it
  // is on Bitbucket — origin/<branch>.
  const branchLine = branch ? (
    <p
      className="mb-2 flex items-center gap-1.5 text-xs text-gray-500"
      title={
        source === 'checkout'
          ? 'The working branch of the checkout on the sandbox, uncommitted changes included.'
          : 'As it is on Bitbucket — nothing is cloned yet.'
      }
    >
      <Icon path={ICONS.gitBranch} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
      <span className="truncate font-mono">
        {source === 'checkout' ? branch : `origin/${branch}`}
      </span>
      <span className="shrink-0 text-[11px] text-gray-400">
        {source === 'checkout' ? 'working branch' : 'not cloned yet'}
      </span>
    </p>
  ) : null;

  return (
    <div>
      {branchLine}
      <ul role="tree" aria-label="Files" className="font-mono">
        {renderDir('', 0)}
      </ul>
    </div>
  );
}
