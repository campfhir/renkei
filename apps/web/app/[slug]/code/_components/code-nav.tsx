'use client';

/**
 * The Code section's list under the app menu, on every page: the code
 * projects this person can open, each with the chats inside it that
 * are theirs or shared with them, most recent first. A chat here never
 * appears among the person's ordinary chats — a code chat belongs to
 * its repository.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import type { ChatSidebarData } from '@/lib/chat/sidebar';

const MAX_CHATS_PER_PROJECT = 5;

const rowClass =
  'flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-900';
const activeClass = 'bg-gray-100 font-medium dark:bg-gray-900';

export function CodeList({ slug, data }: { slug: string; data: ChatSidebarData }) {
  const currentPath = usePathname();
  const { projects, chats } = data.code;
  if (projects.length === 0) {
    return (
      <p className="border-t border-gray-200 px-2 pt-2 text-xs text-gray-500 dark:border-gray-800">
        A code project is a repository a chat can work in.
      </p>
    );
  }
  return (
    <nav aria-label="Code projects" className="border-t border-gray-200 pt-2 dark:border-gray-800">
      {projects.map((project) => {
        const projectHref = `/${slug}/code/${project.id}`;
        const own = chats
          .filter((chat) => chat.projectId === project.id && !chat.archived)
          .slice(0, MAX_CHATS_PER_PROJECT);
        return (
          <div key={project.id} className="mb-2">
            <Link
              href={projectHref}
              aria-current={currentPath === projectHref ? 'page' : undefined}
              className={`${rowClass} ${currentPath === projectHref ? activeClass : ''}`}
            >
              <Icon path={ICONS.terminal} className="h-4 w-4 shrink-0 text-gray-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{project.name}</span>
                <span className="block truncate font-mono text-[11px] text-gray-500">
                  {project.repoFullName ?? ''}
                  {project.ownerName ? ` · ${project.ownerName}` : ''}
                </span>
              </span>
            </Link>
            {own.length > 0 ? (
              <ul className="ml-3 border-l border-gray-200 pl-2 dark:border-gray-800">
                {own.map((chat) => {
                  const href = `/${slug}/chat/${chat.id}`;
                  const active = currentPath === href;
                  return (
                    <li key={chat.id}>
                      <Link
                        href={href}
                        aria-current={active ? 'page' : undefined}
                        className={`block truncate rounded-md px-2 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-900 ${
                          active ? activeClass : 'text-gray-600 dark:text-gray-400'
                        }`}
                      >
                        {chat.title ?? 'New chat'}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
