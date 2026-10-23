'use client';

/**
 * Attach from the library: the viewer's own artifacts, the ones chats
 * generated, and the ones shared with them, each with where it is used
 * already. One copy, many projects — attaching never re-uploads.
 */

import { useEffect, useMemo, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { LoadingRegion, SkeletonList } from '@/components/skeleton';
import { chatClient } from '@/lib/chat/client';
import type { LibraryItem } from '@/lib/chat/artifact-library';
import { ModeToggle, sizeOf, TypeBadge, type Mode } from './artifact-bits';

type Source = 'mine' | 'generated' | 'shared';

export default function AttachArtifactsModal({
  projectId,
  projectName,
  attachedIds,
  onAttached,
  onClose,
}: {
  projectId: string;
  projectName: string;
  attachedIds: string[];
  onAttached: () => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [source, setSource] = useState<Source>('mine');
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<Map<string, Mode>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void chatClient.artifacts().then((result) => {
      if (result.error) setError(result.error);
      setItems(result.data?.artifacts ?? []);
    });
  }, []);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (items ?? []).filter((item) => {
      if (source === 'shared' ? item.via === 'owner' : item.via !== 'owner') return false;
      if (source === 'generated' && item.origin !== 'model') return false;
      if (source === 'mine' && item.origin === 'model') return false;
      return !needle || item.filename.toLowerCase().includes(needle);
    });
  }, [items, source, filter]);

  const toggle = (item: LibraryItem) => {
    setChosen((current) => {
      const next = new Map(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, 'on_demand');
      return next;
    });
  };

  const attach = async () => {
    setBusy(true);
    setError(null);
    let failed: string | null = null;
    for (const [id, mode] of chosen) {
      const result = await chatClient.attachArtifact(projectId, id, mode);
      if (result.error) failed = result.error;
    }
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    onAttached();
    onClose();
  };

  const tab = (value: Source, label: string) => (
    <button
      type="button"
      onClick={() => setSource(value)}
      className={`flex h-7 items-center rounded-md px-2.5 text-xs font-medium ${
        source === value
          ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-950 dark:text-gray-100'
          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
    >
      {label}
    </button>
  );

  return (
    <Modal title={`Attach artifacts to ${projectName}`} onClose={onClose} size="lg">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-gray-500">
          One copy, many projects: attaching here never re-uploads or re-indexes a file.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex shrink-0 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
            {tab('mine', 'Yours')}
            {tab('generated', 'Generated in chats')}
            {tab('shared', 'Shared with you')}
          </div>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name…"
            aria-label="Filter by name"
            className="min-w-[12rem] flex-1 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-800">
          {items === null ? (
            <LoadingRegion label="Loading your artifacts…">
              <div className="p-3">
                <SkeletonList rows={4} />
              </div>
            </LoadingRegion>
          ) : shown.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">
              {source === 'shared'
                ? 'Nothing has been shared with you.'
                : source === 'generated'
                  ? 'No chat has generated a file yet.'
                  : 'No artifacts yet. Upload one from the Artifacts page, or drop a file on the project.'}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-900">
              {shown.map((item) => {
                const already = attachedIds.includes(item.id);
                const picked = chosen.has(item.id);
                return (
                  <li
                    key={item.id}
                    className={`flex items-center gap-3 px-3 py-2 ${already ? 'opacity-60' : ''} ${picked ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Attach ${item.filename}`}
                      checked={already || picked}
                      disabled={already}
                      onChange={() => toggle(item)}
                      className="h-4 w-4"
                    />
                    <TypeBadge filename={item.filename} contentType={item.contentType} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.filename}</span>
                      <span className="block truncate text-xs text-gray-500">
                        {sizeOf(item.sizeBytes)}
                        {already
                          ? ' · already attached'
                          : item.projects.length > 0
                            ? ` · in ${item.projects.map((project) => project.name).join(', ')}`
                            : ' · not attached yet'}
                        {item.ownerName ? ` · shared by ${item.ownerName}` : ''}
                      </span>
                    </span>
                    {picked ? (
                      <ModeToggle
                        label={`How ${projectName} uses ${item.filename}`}
                        value={chosen.get(item.id) ?? 'on_demand'}
                        onChange={(mode) =>
                          setChosen((current) => new Map(current).set(item.id, mode))
                        }
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-2">
          {error ? (
            <p className="mr-auto text-xs text-red-600">{error}</p>
          ) : (
            <p className="mr-auto text-xs text-gray-500">
              {chosen.size === 0 ? 'Pick the files to attach.' : `${chosen.size} to attach`}
            </p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || chosen.size === 0}
            onClick={() => void attach()}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Icon path={ICONS.paperclip} className="h-3.5 w-3.5" />
            {busy ? 'Attaching…' : `Attach ${chosen.size || ''}`.trim()}
          </button>
        </div>
      </div>
    </Modal>
  );
}
