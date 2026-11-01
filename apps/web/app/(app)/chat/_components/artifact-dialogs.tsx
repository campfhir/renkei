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

import { useEffect, useReducer, useState } from 'react';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { LoadingRegion, SkeletonList } from '@/components/skeleton';
import { chatClient } from '@/lib/chat/client';
import type { LibraryItem } from '@/lib/chat/artifact-library';
import { DialogFooter } from './chat-nav';
import { TypeBadge } from './artifact-bits';
import { personName, personSuggestions, type Person } from './share-modal.model';
import {
  aloneLine,
  copyReducer,
  copyRequest,
  deleteFooter,
  deleteReducer,
  deleteRequest,
  impactProjectLine,
  initialCopy,
  initialDelete,
  initialRename,
  othersUse,
  renameReducer,
  renameRequest,
  sharedWithLine,
} from './artifact-dialogs.model';

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
  const suggestions = personSuggestions(people, query, exclude);
  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-gray-300 px-2 py-1.5 dark:border-gray-700">
        <span className="flex-1 truncate">{personName(value)}</span>
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
  const [state, dispatch] = useReducer(deleteReducer, initialDelete);
  const { impact, choice, newOwner, error } = state;

  useEffect(() => {
    void chatClient.artifactImpact(item.id).then((result) => {
      dispatch({ type: 'impactLoaded', impact: result.data?.impact ?? null, error: result.error });
    });
  }, [item.id]);

  const othersUseIt = othersUse(impact);
  const footer = deleteFooter(state);

  const confirm = async () => {
    dispatch({ type: 'sent' });
    const request = deleteRequest(state);
    const result =
      request.kind === 'transfer'
        ? await chatClient.transferArtifact(item.id, request.newOwnerSubject)
        : await chatClient.deleteArtifact(item.id);
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    dispatch({ type: 'done' });
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
                  <span className="flex-1">{impactProjectLine(project)}</span>
                </li>
              ))}
              {impact.sharedWith.length > 0 ? (
                <li className="flex gap-2">
                  <Icon path={ICONS.share} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">{sharedWithLine(impact)}</span>
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
          <p className="text-gray-600 dark:text-gray-400">{aloneLine(impact)}</p>
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
                onChange={() => dispatch({ type: 'choiceChanged', choice: 'transfer' })}
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
                      onChange={(person) => dispatch({ type: 'ownerChosen', person })}
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
                onChange={() => dispatch({ type: 'choiceChanged', choice: 'delete' })}
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
          busy={footer.disabled}
          error={error}
          label={footer.label}
          danger={footer.danger}
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
  const [state, dispatch] = useReducer(copyReducer, item.filename, initialCopy);
  const { filename, attachProjectId, busy, error } = state;

  const copy = async () => {
    dispatch({ type: 'sent' });
    const result = await chatClient.copyArtifact(item.id, copyRequest(state));
    if (result.error || !result.data) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    dispatch({ type: 'done' });
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
            onChange={(event) => dispatch({ type: 'named', filename: event.target.value })}
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
              onChange={(event) =>
                dispatch({ type: 'projectChosen', projectId: event.target.value })
              }
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
  const [state, dispatch] = useReducer(renameReducer, item.filename, initialRename);
  const { filename, busy, error } = state;
  const rename = async () => {
    dispatch({ type: 'sent' });
    const result = await chatClient.renameArtifact(item.id, renameRequest(state));
    if (result.error) {
      dispatch({ type: 'failed', error: result.error });
      return;
    }
    dispatch({ type: 'done' });
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
            onChange={(event) => dispatch({ type: 'named', filename: event.target.value })}
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
