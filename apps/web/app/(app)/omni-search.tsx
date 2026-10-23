'use client';

/**
 * The search in the top bar: one box for what a person is after — a page
 * or a setting in the menu, a chat project or code project, a chat by its
 * title or by what was said in it. Ctrl/⌘K moves to it from anywhere, and
 * the arrow keys and Enter pick a result. The chats searched are the whole
 * history, fetched on first focus (the menu only carries the recent window);
 * what was said is found through the search route, debounced.
 */

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';
import { chatClient } from '@/lib/chat/client';
import type { LibraryItem } from '@/lib/chat/artifact-library';
import type { ChatSidebarData } from '@/lib/chat/sidebar';
import { CHAT_SEARCH_MIN_CHARS, normalizeQuery } from '@/lib/chat/search-text';
import type { ChatListItem } from '@/lib/chat/views';
import { matchPlaces, type AppPlace } from '@/lib/app-index';
import { scrollToHash } from '@/lib/hash-scroll';

/** A place in the app's menu, from the menu's own list so the two agree. */
export interface OmniPage {
  label: string;
  href: string;
  icon: string;
}

interface Result {
  href: string;
  label: string;
  /** A second line: the project a chat sits in, or the line it was found by. */
  detail?: string;
  icon: string;
}

interface Section {
  title: string;
  results: Result[];
}

const LIMITS = { pages: 6, places: 6, projects: 5, artifacts: 5, chats: 8 };

export function OmniSearch({
  pages,
  chats,
  isOperator,
}: {
  pages: OmniPage[];
  chats: ChatSidebarData | null;
  isOperator: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // On a phone the field is folded into a magnifier button until asked for.
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  // The whole history, once a person first reaches for the search; until
  // it arrives the menu's recent window stands in.
  const [allChats, setAllChats] = useState<ChatListItem[] | null>(null);
  const loadingAll = useRef(false);
  const loadAll = () => {
    if (allChats !== null || loadingAll.current) return;
    loadingAll.current = true;
    void chatClient.sidebar().then((result) => {
      loadingAll.current = false;
      if (result.data) setAllChats(result.data.chats);
    });
  };

  // What was said: asked of the server once the box holds enough to scan,
  // and kept only for the text it was asked for, so fast typing cannot
  // show a stale line under a newer query.
  const text = normalizeQuery(query);
  const needle = text.toLowerCase();
  const searchable = text.length >= CHAT_SEARCH_MIN_CHARS;
  const [said, setSaid] = useState<{ query: string; hits: Map<string, string> }>({
    query: '',
    hits: new Map(),
  });
  useEffect(() => {
    if (!searchable) return;
    const handle = setTimeout(async () => {
      const result = await chatClient.searchChats(text);
      setSaid({
        query: text,
        hits: new Map((result.data?.hits ?? []).map((hit) => [hit.chatId, hit.snippet])),
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [text, searchable]);
  const hits = said.query === text ? said.hits : new Map<string, string>();
  // Artifacts by what they hold, through the library's own search.
  const [found, setFound] = useState<{ query: string; items: LibraryItem[] }>({
    query: '',
    items: [],
  });
  useEffect(() => {
    if (!searchable) return;
    const handle = setTimeout(async () => {
      const result = await chatClient.findArtifacts(text);
      setFound({ query: text, items: result.data?.artifacts ?? [] });
    }, 300);
    return () => clearTimeout(handle);
  }, [text, searchable]);
  const artifacts = found.query === text ? found.items : [];
  const saidPending = searchable && said.query !== text;

  // Clicking through a result leaves the page the box was used on.
  useEffect(() => {
    setQuery('');
    setOpen(false);
    setExpanded(false);
  }, [pathname]);

  // Ctrl/⌘K from anywhere in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
        loadAll();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [allChats]);

  const sections = buildSections({
    needle,
    query: text,
    searchable,
    isOperator,
    artifacts,
    pages,
    // Chat projects and code projects come in separate lists from the sidebar.
    projects: [...(chats?.projects ?? []), ...(chats?.code.projects ?? [])],
    chats: allChats ?? chats?.chats ?? [],
    hits,
  });
  const flat = sections.flatMap((section) => section.results);
  const showing = open && needle.length > 0;
  const current = Math.min(active, Math.max(flat.length - 1, 0));

  const closeSearch = () => {
    setQuery('');
    setOpen(false);
    setExpanded(false);
    inputRef.current?.blur();
  };

  const choose = (href: string) => {
    closeSearch();
    router.push(href);
    // A link to the same page only changes its address, so the scroll is ours.
    window.setTimeout(scrollToHash, 60);
  };

  let index = -1;
  return (
    <>
      <button
        type="button"
        aria-label="Search"
        onClick={() => {
          setExpanded(true);
          setOpen(true);
          loadAll();
        }}
        className={`ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 sm:hidden dark:text-gray-300 dark:hover:bg-gray-900 ${expanded ? 'hidden' : ''}`}
      >
        <Icon path={ICONS.search} className="h-5 w-5" />
      </button>
      <div
        ref={ref}
        className={`relative mx-auto min-w-0 max-w-xl flex-1 ${expanded ? '' : 'hidden sm:block'}`}
      >
        <div className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-2.5 focus-within:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:focus-within:border-blue-700">
          <Icon path={ICONS.search} className="h-4 w-4 shrink-0 text-gray-400" />
          <input
            ref={inputRef}
            type="search"
            role="searchbox"
            aria-label="Search Renkei"
            aria-expanded={showing}
            aria-controls="omni-search-results"
            value={query}
            onFocus={() => {
              setOpen(true);
              loadAll();
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => (flat.length ? (value + 1) % flat.length : 0));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) => (flat.length ? (value - 1 + flat.length) % flat.length : 0));
              } else if (event.key === 'Enter' && flat[current]) {
                event.preventDefault();
                choose(flat[current].href);
              } else if (event.key === 'Escape') {
                if (query) setQuery('');
                else closeSearch();
                setOpen(false);
              }
            }}
            placeholder="Search chats, projects, settings…"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-base outline-none sm:text-sm [&::-webkit-search-cancel-button]:appearance-none"
          />
          <kbd
            aria-hidden="true"
            className="hidden shrink-0 rounded border border-gray-300 px-1 text-[11px] text-gray-500 sm:block dark:border-gray-700"
          >
            Ctrl K
          </kbd>
          <button
            type="button"
            aria-label="Close search"
            onClick={closeSearch}
            className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 sm:hidden dark:hover:bg-gray-800"
          >
            <Icon path={ICONS.close} className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>

        {showing ? (
          <div
            id="omni-search-results"
            role="listbox"
            aria-label="Results"
            className="absolute inset-x-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-800 dark:bg-gray-950"
          >
            {flat.length === 0 ? (
              <p className="px-2 py-3 text-sm text-gray-500">
                {saidPending ? 'Searching…' : `Nothing matches “${query.trim()}”.`}
              </p>
            ) : null}
            {sections.map((section) => (
              <div key={section.title} className="py-1">
                <p className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
                  {section.title}
                </p>
                {section.results.map((result) => {
                  index += 1;
                  const position = index;
                  const selected = position === current;
                  return (
                    <button
                      key={`${section.title}-${result.href}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActive(position)}
                      onClick={() => choose(result.href)}
                      className={`flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${
                        selected ? 'bg-gray-100 dark:bg-gray-900' : ''
                      }`}
                    >
                      <Icon path={result.icon} className="h-4 w-4 shrink-0 text-gray-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{result.label}</span>
                        {result.detail ? (
                          <span className="block truncate text-xs text-gray-500">
                            {result.detail}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** The same address with the search's words added, so the page can use them. */
function withFind(href: string, query: string): string {
  const [path, hash] = href.split('#');
  const search = new URLSearchParams({ find: query }).toString();
  return `${path}?${search}${hash ? `#${hash}` : ''}`;
}

function buildSections({
  needle,
  query,
  searchable,
  isOperator,
  artifacts,
  pages,
  projects,
  chats,
  hits,
}: {
  needle: string;
  query: string;
  searchable: boolean;
  isOperator: boolean;
  artifacts: LibraryItem[];
  pages: OmniPage[];
  projects: ChatSidebarData['projects'];
  chats: ChatListItem[];
  hits: Map<string, string>;
}): Section[] {
  if (!needle) return [];
  const has = (text: string | null | undefined) => (text ?? '').toLowerCase().includes(needle);

  const pageResults = pages
    .filter((page) => has(page.label))
    .slice(0, LIMITS.pages)
    .map((page) => ({ href: page.href, label: page.label, icon: page.icon }));

  const projectResults = projects
    .filter((project) => has(project.name))
    .slice(0, LIMITS.projects)
    .map((project) => ({
      href: project.repoFullName ? `/code/${project.id}` : `/chat/projects/${project.id}`,
      label: project.name,
      detail: project.repoFullName ?? 'Chat project',
      icon: project.repoFullName ? ICONS.code : ICONS.pages,
    }));

  // A chat matches by its title or its project's name, or by a line said
  // in it. Title matches come first; a chat found only by what was said
  // shows that line under its title.
  const chatResult = (chat: ChatListItem, detail: string | undefined): Result => ({
    href: `/chat/${chat.id}`,
    label: chat.title ?? 'New chat',
    detail,
    icon: chat.projectKind === 'code' ? ICONS.code : chat.projectId ? ICONS.pages : ICONS.chat,
  });
  const byTitle = chats
    .filter((chat) => has(chat.title ?? 'New chat') || has(chat.projectName))
    .map((chat) => chatResult(chat, chat.projectName ?? undefined));
  const bySaid = chats
    .filter((chat) => hits.has(chat.id) && !byTitle.some((r) => r.href === `/chat/${chat.id}`))
    .map((chat) => chatResult(chat, hits.get(chat.id)));

  // Settings, connectors and organization settings, each down to the
  // element that holds them; the organization's only for operators.
  const placeResults = (section: AppPlace['section']) =>
    matchPlaces(needle, isOperator)
      .filter((place) => place.section === section)
      .slice(0, LIMITS.places)
      .map((place): Result => ({
        // A connector not on the page is searched for in the catalog.
        href: section === 'Connectors' ? withFind(place.href, query) : place.href,
        label: place.title,
        detail: place.where,
        icon: place.icon,
      }));

  // The library's own search first, so a person can see all of it; then the
  // artifacts it found, each opened where it is.
  const artifactResults: Result[] = [
    ...(searchable
      ? [
          {
            href: `/chat/artifacts?q=${encodeURIComponent(query)}`,
            label: `Search artifacts for “${query}”`,
            detail: 'Names and contents',
            icon: ICONS.search,
          },
        ]
      : []),
    ...artifacts.slice(0, LIMITS.artifacts).map((item): Result => ({
      href: `/chat/artifacts?artifact=${item.id}`,
      label: item.filename,
      detail: item.chat?.title ?? 'Artifact',
      icon: ICONS.layers,
    })),
  ];

  const sections: Section[] = [
    { title: 'Settings', results: placeResults('Settings') },
    { title: 'Connectors', results: placeResults('Connectors') },
    { title: 'Organization', results: placeResults('Organization') },
    { title: 'Pages', results: pageResults },
    { title: 'Projects', results: projectResults },
    { title: 'Artifacts', results: artifactResults },
    { title: 'Chats', results: [...byTitle, ...bySaid].slice(0, LIMITS.chats) },
  ];
  return sections.filter((section) => section.results.length > 0);
}
