'use client';

/**
 * The dialogs an artifact's owner and the people it is shared with
 * meet (docs/artifacts-design.md):
 *
 *   - Delete: the impact first — the projects (and how many people read
 *     it there), the direct shares, the chat it came from — and, when
 *     anyone else uses it, hand-over as the default over deletion.
 *   - Copy: a file someone shared becomes one of the viewer's own, named
 *     by them, optionally attached to a project in place of the original;
 *     the original's owner is told.
 *   - Rename: the name, for everyone who sees it.
 */

import { useEffect, useMemo, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { LoadingRegion, SkeletonList } from '@/components/skeleton';
import { chatClient } from '@/lib/chat/client';
import type { ArtifactImpact, LibraryItem } from '@/lib/chat/artifact-library';
import { DialogFooter } from './chat-nav';
import { TypeBadge } from './artifact-bits';

interface Person {
  subject: string;
  email: string;
  displayName: string | null;
}

function PersonPicker({
  value,
  onChange,
  exclude,
  label,
}: {
  value: Person | null;
  onChange: (person: Person | null) => void;
  exclude: string[];
  label: string;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [query, setQuery] = useState('');
  useEffect(() => {
    void chatClient.people().then((result) => {
      if (result.data) setPeople(result.data.people);
    });
  }, []);
  const suggestions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return people
      .filter((person) => !exclude.includes(person.subject))
      .filter(
        (person) =>
          person.email.toLowerCase().includes(needle) ||
          (person.displayName ?? '').toLowerCase().includes(needle)
      )
      .slice(0, 6);
  }, [people, query, exclude]);
  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700">
        <span className="flex-1 truncate">{value.displayName ?? value.email}</span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-xs text-gray-500 hover:underline"
        >
          change
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Name or email"
        aria-label={label}
        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
      />
      {suggestions.length > 0 ? (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
          {suggestions.map((person) => (
            <li key={person.subject}>
              <button
                type="button"
                onClick={() => {
                  onChange(person);
                  setQuery('');
                }}
                className="block w-full px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {person.displayName ?? person.email}
                {person.displayName ? (
                  <span className="ml-1 text-xs text-gray-500">{person.email}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function DeleteArtifactModal({
  item,
  onDone,
  onClose,
}: {
  item: LibraryItem;
  onDone: () => void;
  onClose: () => void;
}) {
  const [impact, setImpact] = useState<ArtifactImpact | null>(null);
  const [choice, setChoice] = useState<'transfer' | 'delete'>('delete');
  const [newOwner, setNewOwner] = useState<Person | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void chatClient.artifactImpact(item.id).then((result) => {
      if (result.error) setError(result.error);
      const loaded = result.data?.impact ?? { projects: [], sharedWith: [], chat: null };
      setImpact(loaded);
      if (loaded.projects.length > 0 || loaded.sharedWith.length > 0) setChoice('transfer');
    });
  }, [item.id]);

  const othersUseIt = impact ? impact.projects.length > 0 || impact.sharedWith.length > 0 : false;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const result =
      choice === 'transfer' && newOwner
        ? await chatClient.transferArtifact(item.id, newOwner.subject)
        : await chatClient.deleteArtifact(item.id);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone();
    onClose();
  };

  return (
    <Modal title={`Delete ${item.filename}?`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {impact === null ? (
          <LoadingRegion label="Working out who uses it…">
            <SkeletonList rows={2} />
          </LoadingRegion>
        ) : othersUseIt ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="mb-1 font-medium">Deleting removes the file for everyone</p>
            <ul className="space-y-0.5">
              {impact.projects.map((project) => (
                <li key={project.id} className="flex gap-2">
                  <Icon path={ICONS.pages} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">
                    {project.name} · {project.members}{' '}
                    {project.members === 1 ? 'member' : 'members'}
                    {project.mode === 'always' ? ' · kept in context' : ''}
                  </span>
                </li>
              ))}
              {impact.sharedWith.length > 0 ? (
                <li className="flex gap-2">
                  <Icon path={ICONS.share} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">
                    Shared with{' '}
                    {impact.sharedWith
                      .map((person) => person.name ?? person.email ?? '…')
                      .join(', ')}
                  </span>
                </li>
              ) : null}
              {impact.chat ? (
                <li className="flex gap-2">
                  <Icon path={ICONS.chat} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">
                    From the chat “{impact.chat.title ?? 'Untitled'}” — its text there is kept
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <p className="text-gray-600 dark:text-gray-400">
            Nobody else uses this file{impact.chat ? ' beyond the chat it came from' : ''}. It is
            removed for good.
          </p>
        )}

        {othersUseIt ? (
          <div className="space-y-2" role="radiogroup" aria-label="What to do">
            <label
              className={`flex cursor-pointer gap-2 rounded-md border p-2.5 ${choice === 'transfer' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30' : 'border-gray-200 dark:border-gray-800'}`}
            >
              <input
                type="radio"
                name="delete-choice"
                checked={choice === 'transfer'}
                onChange={() => setChoice('transfer')}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Hand it over instead</span>
                <span className="block text-xs text-gray-500">
                  The new owner keeps the file, every project attachment and every share. Your own
                  access ends; they can share it back.
                </span>
                {choice === 'transfer' ? (
                  <span className="mt-2 block">
                    <PersonPicker
                      value={newOwner}
                      onChange={setNewOwner}
                      exclude={[item.ownerSubject]}
                      label="New owner"
                    />
                  </span>
                ) : null}
              </span>
            </label>
            <label
              className={`flex cursor-pointer gap-2 rounded-md border p-2.5 ${choice === 'delete' ? 'border-red-400 bg-red-50 dark:bg-red-950/30' : 'border-gray-200 dark:border-gray-800'}`}
            >
              <input
                type="radio"
                name="delete-choice"
                checked={choice === 'delete'}
                onChange={() => setChoice('delete')}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Delete it for everyone</span>
                <span className="block text-xs text-gray-500">
                  Detached from every project and gone from everyone’s list. Cannot be undone.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        <DialogFooter
          busy={busy || impact === null || (choice === 'transfer' && !newOwner)}
          error={error}
          label={
            choice === 'transfer' && othersUseIt
              ? `Hand over${newOwner ? ` to ${newOwner.displayName ?? newOwner.email}` : ''}`
              : 'Delete'
          }
          danger={choice === 'delete' || !othersUseIt}
          onCancel={onClose}
          onConfirm={() => void confirm()}
        />
      </div>
    </Modal>
  );
}

export function CopyArtifactModal({
  item,
  projects,
  onDone,
  onClose,
}: {
  item: LibraryItem;
  projects: { id: string; name: string }[];
  onDone: (artifactId: string) => void;
  onClose: () => void;
}) {
  const dot = item.filename.lastIndexOf('.');
  const [filename, setFilename] = useState(
    dot > 0
      ? `${item.filename.slice(0, dot)} (copy)${item.filename.slice(dot)}`
      : `${item.filename} (copy)`
  );
  const [attachProjectId, setAttachProjectId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    setBusy(true);
    setError(null);
    const result = await chatClient.copyArtifact(item.id, {
      filename: filename.trim() || undefined,
      attachProjectId: attachProjectId || null,
    });
    setBusy(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'The copy could not be made.');
      return;
    }
    onDone(result.data.artifactId);
    onClose();
  };

  return (
    <Modal title={`Make a copy of ${item.filename}?`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void copy();
        }}
        className="space-y-3 text-sm"
      >
        <p className="text-xs text-gray-500">
          {item.ownerName ?? 'Its owner'} shared this with you. A copy is a separate file you own
          and can change; it won’t follow their updates.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-500">Name of your copy</span>
          <input
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
            maxLength={255}
            required
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </label>
        {projects.length > 0 ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-500">Attach the copy to</span>
            <select
              value={attachProjectId}
              onChange={(event) => setAttachProjectId(event.target.value)}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="">Nowhere yet</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p className="flex items-center gap-1.5 text-xs text-gray-500">
          <Icon path={ICONS.bell} className="h-3.5 w-3.5" />
          {item.ownerName ?? 'The owner'} will be told you made a copy.
        </p>
        <DialogFooter busy={busy} error={error} label="Make a copy" onCancel={onClose} />
      </form>
    </Modal>
  );
}

export function RenameArtifactModal({
  item,
  onDone,
  onClose,
}: {
  item: LibraryItem;
  onDone: () => void;
  onClose: () => void;
}) {
  const [filename, setFilename] = useState(item.filename);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rename = async () => {
    setBusy(true);
    const result = await chatClient.renameArtifact(item.id, filename.trim());
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone();
    onClose();
  };
  return (
    <Modal title="Rename" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
        className="space-y-3 text-sm"
      >
        <div className="flex items-center gap-2">
          <TypeBadge filename={filename} contentType={item.contentType} />
          <input
            autoFocus
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
            maxLength={255}
            required
            aria-label="File name"
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
        <p className="text-xs text-gray-500">Everyone who uses it sees the new name.</p>
        <DialogFooter busy={busy} error={error} label="Rename" onCancel={onClose} />
      </form>
    </Modal>
  );
}
