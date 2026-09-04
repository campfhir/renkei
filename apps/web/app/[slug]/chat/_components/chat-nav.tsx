'use client';

/**
 * The chat list under the app menu's Chat section, on every page: mine
 * grouped by day (archived ones behind a switch), then the ones shared
 * with me; each row names its project underneath. Row actions live
 * behind a "⋯" menu — the notifications list's idiom — and every
 * mutation goes through a route and then router.refresh(), so the
 * layout's server data is the truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import Modal from '@/components/modal';
import { useDismiss } from '@/lib/use-dismiss';
import { chatClient } from '@/lib/chat/client';
import type { ChatSidebarData, ProjectListItem } from '@/lib/chat/sidebar';
import type { ChatListItem } from '@/lib/chat/views';
import ShareModal from './share-modal';

function dayGroup(iso: string, now: Date): string {
  const date = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (date.getTime() >= startOfToday) return 'Today';
  if (date.getTime() >= startOfToday - day) return 'Yesterday';
  if (date.getTime() >= startOfToday - 7 * day) return 'This week';
  return 'Earlier';
}

const rowClass =
  'group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-900';
const activeClass = 'bg-gray-100 font-medium dark:bg-gray-900';

export function ChatList({
  slug,
  tenantId,
  data,
}: {
  slug: string;
  tenantId: string;
  data: ChatSidebarData;
}) {
  const currentPath = usePathname();
  const [filter, setFilter] = useState('');
  // Which states the list shows; active only, until the funnel says otherwise.
  const [states, setStates] = useState<{ active: boolean; archived: boolean }>({
    active: true,
    archived: false,
  });
  const counts = useMemo(
    () => ({
      active: data.chats.filter((chat) => !chat.archived).length,
      archived: data.chats.filter((chat) => chat.archived).length,
    }),
    [data.chats]
  );
  const shown = useCallback(
    (chat: ChatListItem) =>
      (chat.archived ? states.archived : states.active) && matches(chat, filter),
    [states, filter]
  );
  const mine = useMemo(
    () => data.chats.filter((chat) => chat.via === 'owner' && shown(chat)),
    [data.chats, shown]
  );
  const shared = useMemo(
    () => data.chats.filter((chat) => chat.via !== 'owner' && shown(chat)),
    [data.chats, shown]
  );
  const groups = useMemo(() => {
    const now = new Date();
    const out = new Map<string, ChatListItem[]>();
    for (const chat of mine) {
      const key = dayGroup(chat.updatedAt, now);
      out.set(key, [...(out.get(key) ?? []), chat]);
    }
    return [...out.entries()];
  }, [mine]);

  return (
    <div className="border-t border-gray-200 pt-2 dark:border-gray-800">
      <div className="mb-2 flex items-center rounded-md border border-gray-300 bg-white pr-1 focus-within:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:focus-within:border-blue-700">
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Find a chat"
          aria-label="Find a chat"
          className="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm outline-none"
        />
        <StateFilter states={states} onChange={setStates} counts={counts} />
      </div>
      <nav aria-label="Chats">
        {groups.length === 0 && shared.length === 0 ? (
          <p className="px-2 text-xs text-gray-500">
            {filter
              ? 'No chats match.'
              : data.chats.length === 0
                ? 'Your chats will appear here.'
                : !states.active && !states.archived
                  ? 'Nothing to show — pick Active or Archived.'
                  : states.active
                    ? 'No active chats.'
                    : 'No archived chats.'}
          </p>
        ) : null}
        {groups.map(([label, chats]) => (
          <div key={label} className="mb-3">
            <SectionTitle>{label}</SectionTitle>
            {chats.map((chat) => (
              <ChatRow
                key={chat.id}
                slug={slug}
                tenantId={tenantId}
                chat={chat}
                projects={data.projects}
                active={currentPath === `/${slug}/chat/${chat.id}`}
              />
            ))}
          </div>
        ))}
        {shared.length > 0 ? (
          <div className="mb-3">
            <SectionTitle>Shared with me</SectionTitle>
            {shared.map((chat) => (
              <ChatRow
                key={chat.id}
                slug={slug}
                tenantId={tenantId}
                chat={chat}
                projects={data.projects}
                active={currentPath === `/${slug}/chat/${chat.id}`}
              />
            ))}
          </div>
        ) : null}
      </nav>
    </div>
  );
}

/**
 * The funnel in the search box: which states the list shows, each on its
 * own switch, in the same menu idiom as the model picker. A dot on the
 * funnel says the list is not showing the default (active only).
 */
function StateFilter({
  states,
  onChange,
  counts,
}: {
  states: { active: boolean; archived: boolean };
  onChange: (states: { active: boolean; archived: boolean }) => void;
  counts: { active: number; archived: number };
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  const custom = !states.active || states.archived;
  const option = (key: 'active' | 'archived', label: string) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={states[key]}
      onClick={() => onChange({ ...states, [key]: !states[key] })}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-blue-600 dark:text-blue-400">
        {states[key] ? <Icon path={ICONS.check} className="h-4 w-4" strokeWidth={2.4} /> : null}
      </span>
      <span className="flex-1">{label}</span>
      <span className="text-xs text-gray-400">{counts[key]}</span>
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Filter chats"
        title="Which chats to show"
        className="relative rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
      >
        <Icon path={ICONS.filter} className="h-4 w-4" />
        {custom ? (
          <span
            aria-hidden="true"
            className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-blue-600"
          />
        ) : null}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-44 rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Show
          </p>
          {option('active', 'Active')}
          {option('archived', 'Archived')}
        </div>
      ) : null}
    </div>
  );
}

function matches(chat: ChatListItem, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return (chat.title ?? 'new chat').toLowerCase().includes(needle);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-center px-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
      {children}
    </div>
  );
}

function ChatRow({
  slug,
  tenantId,
  chat,
  projects,
  active,
}: {
  slug: string;
  tenantId: string;
  chat: ChatListItem;
  projects: ProjectListItem[];
  active: boolean;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'move' | 'share' | 'delete' | null>(null);
  const [title, setTitle] = useState(chat.title ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuOpen, menuRef, () => setMenuOpen(false));
  const isOwner = chat.via === 'owner';

  const run = async (action: () => Promise<{ error: string | null }>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setDialog(null);
    router.refresh();
  };

  return (
    <div className={`${rowClass} ${active ? activeClass : ''}`}>
      <Link
        href={`/${slug}/chat/${chat.id}`}
        className={`min-w-0 flex-1 truncate ${chat.archived ? 'text-gray-500' : ''}`}
      >
        {chat.title ?? 'New chat'}
        {chat.archived ? (
          <span className="ml-1.5 rounded bg-gray-200 px-1 text-[10px] font-medium uppercase text-gray-600 dark:bg-gray-800 dark:text-gray-400">
            archived
          </span>
        ) : null}
        {chat.projectName || chat.ownerName ? (
          <span className="flex items-center gap-1 truncate text-[11px] font-normal text-gray-500">
            {chat.projectName ? (
              <>
                <Icon path={ICONS.folder} className="h-3 w-3 shrink-0" />
                <span className="truncate">{chat.projectName}</span>
              </>
            ) : null}
            {chat.ownerName ? (
              <span className="truncate">
                {chat.projectName ? '· ' : ''}
                {chat.via === 'project' ? 'by ' : 'Shared by '}
                {chat.ownerName}
              </span>
            ) : null}
          </span>
        ) : null}
      </Link>
      {isOwner ? (
        <div ref={menuRef} className="relative">
          <button
            type="button"
            aria-label="Chat actions"
            onClick={() => setMenuOpen((value) => !value)}
            className="rounded p-1 text-gray-400 opacity-0 hover:bg-gray-200 hover:text-gray-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <Icon path={ICONS.moreHorizontal} className="h-4 w-4" strokeWidth={2.4} />
          </button>
          {menuOpen ? (
            <div className="absolute right-0 z-40 mt-1 w-40 overflow-hidden rounded-md border border-gray-200 bg-white text-sm shadow-lg dark:border-gray-700 dark:bg-gray-900">
              {(['rename', 'move', 'share', 'archive', 'delete'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    if (item === 'archive') {
                      void run(() =>
                        chatClient.updateChat(tenantId, chat.id, { archived: !chat.archived })
                      );
                      return;
                    }
                    setDialog(item);
                  }}
                  className={`block w-full px-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-gray-800 ${item === 'delete' ? 'text-red-600 dark:text-red-400' : ''}`}
                >
                  {item === 'rename'
                    ? 'Rename'
                    : item === 'move'
                      ? 'Move to project…'
                      : item === 'share'
                        ? 'Share…'
                        : item === 'archive'
                          ? chat.archived
                            ? 'Unarchive'
                            : 'Archive'
                          : 'Delete'}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {dialog === 'rename' ? (
        <Modal title="Rename chat" onClose={() => setDialog(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => chatClient.updateChat(tenantId, chat.id, { title: title.trim() }));
            }}
            className="space-y-3"
          >
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <DialogFooter
              busy={busy}
              error={error}
              label="Rename"
              onCancel={() => setDialog(null)}
            />
          </form>
        </Modal>
      ) : null}
      {dialog === 'move' ? (
        <Modal title="Move to project" onClose={() => setDialog(null)}>
          <div className="space-y-1">
            <button
              type="button"
              disabled={busy || chat.projectId === null}
              onClick={() => void run(() => chatClient.moveChat(tenantId, chat.id, null))}
              className="block w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800"
            >
              No project
            </button>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                disabled={busy || chat.projectId === project.id}
                onClick={() => void run(() => chatClient.moveChat(tenantId, chat.id, project.id))}
                className="block w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800"
              >
                {project.name}
              </button>
            ))}
            {projects.length === 0 ? (
              <p className="px-3 text-sm text-gray-500">You have no projects yet.</p>
            ) : null}
            {error ? <p className="px-3 text-sm text-red-600">{error}</p> : null}
          </div>
        </Modal>
      ) : null}
      {dialog === 'share' ? (
        <ShareModal
          tenantId={tenantId}
          kind="chat"
          resourceId={chat.id}
          title={`Share “${chat.title ?? 'New chat'}”`}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'delete' ? (
        <Modal title="Delete chat" onClose={() => setDialog(null)}>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            This deletes the chat, its messages and its files for everyone it was shared with.
          </p>
          <DialogFooter
            busy={busy}
            error={error}
            label="Delete"
            danger
            onCancel={() => setDialog(null)}
            onConfirm={() =>
              void run(async () => {
                const result = await chatClient.deleteChat(tenantId, chat.id);
                if (!result.error && active) router.push(`/${slug}/chat`);
                return result;
              })
            }
          />
        </Modal>
      ) : null}
    </div>
  );
}

export function DialogFooter({
  busy,
  error,
  label,
  danger,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string | null;
  label: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {error ? (
        <p className="mr-auto text-sm text-red-600">{error}</p>
      ) : (
        <span className="mr-auto" />
      )}
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-700"
      >
        Cancel
      </button>
      <button
        type={onConfirm ? 'button' : 'submit'}
        onClick={onConfirm}
        disabled={busy}
        className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
      >
        {busy ? 'Working…' : label}
      </button>
    </div>
  );
}
