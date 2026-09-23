'use client';

/**
 * The chat's name in the title bar, and — for its owner — the way to
 * change it: a double-click on the name, or (on a wide screen, revealed
 * on hover) a pencil beside it, turns it into a field; Enter or leaving
 * the field saves, Escape puts the old name back. On a narrow screen the
 * pencil is dropped in favor of the title bar's overflow menu, which has
 * its own Rename. Under the name, the project the chat sits in, when it
 * does — and, for a code project, the branch its checkout is on right now.
 * A `tag` (a code project's "history") sits beside the name.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Icon, ICONS } from '@/components/icons';

export default function ChatTitle({
  title,
  project,
  tag = null,
  canRename,
  onRename,
}: {
  title: string;
  project: { id: string; name: string; href: string; branch?: string | null } | null;
  /** A short word after the name — what state the chat is in, when that matters. */
  tag?: string | null;
  canRename: boolean;
  /** Saves the new name; resolves to the name as stored, or null on failure. */
  onRename: ((title: string) => Promise<string | null>) | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = () => {
    if (!canRename || !onRename) return;
    setDraft(title);
    setEditing(true);
  };
  const save = async () => {
    if (!onRename || saving) return;
    const next = draft.trim();
    if (!next || next === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    await onRename(next);
    setSaving(false);
    setEditing(false);
  };

  return (
    <div className="min-w-0 flex-1">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void save();
            } else if (event.key === 'Escape') {
              setEditing(false);
            }
          }}
          maxLength={200}
          aria-label="Chat name"
          disabled={saving}
          className="w-full rounded-md border border-blue-400 bg-white px-1.5 py-0.5 text-sm font-semibold outline-none dark:border-blue-700 dark:bg-gray-900"
        />
      ) : (
        <div className="group flex min-w-0 items-center gap-1.5">
          <h1
            className={`truncate text-sm font-semibold ${canRename ? 'cursor-text' : ''}`}
            onDoubleClick={start}
            title={canRename ? 'Double-click to rename' : undefined}
          >
            {title}
          </h1>
          {tag ? (
            <span
              data-testid="chat-tag"
              className="shrink-0 rounded bg-gray-200 px-1 text-[10px] font-medium uppercase text-gray-600 dark:bg-gray-800 dark:text-gray-400"
            >
              {tag}
            </span>
          ) : null}
          {canRename ? (
            <button
              type="button"
              onClick={start}
              aria-label="Rename chat"
              title="Rename"
              className="hidden shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 lg:inline-flex lg:opacity-0 lg:group-hover:opacity-100 lg:focus:opacity-100 dark:hover:bg-gray-900 dark:hover:text-gray-200"
            >
              <Icon path={ICONS.pencil} className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      )}
      {project ? (
        <Link
          href={project.href}
          className="flex min-w-0 items-center gap-1 text-xs text-gray-500 hover:text-gray-800 hover:underline dark:hover:text-gray-200"
        >
          <Icon path={ICONS.folder} className="h-3 w-3 shrink-0" />
          <span className="truncate">{project.name}</span>
          {project.branch ? (
            <span
              className="flex min-w-0 shrink items-center gap-0.5 font-mono"
              title={`The checkout is on ${project.branch}`}
              data-testid="chat-branch"
            >
              <span aria-hidden="true">·</span>
              <Icon path={ICONS.gitBranch} className="h-3 w-3 shrink-0" />
              <span className="truncate">{project.branch}</span>
            </span>
          ) : null}
        </Link>
      ) : null}
    </div>
  );
}
