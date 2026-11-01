'use client';

/**
 * The search in the top bar: one box for what a person is after — a page
 * or a setting in the menu, a chat project or code project, a chat by its
 * title or by what was said in it. Ctrl/⌘K (⌘ on a Mac) moves to it from anywhere, and
 * the arrow keys and Enter pick a result. The chats searched are the whole
 * history, fetched on first focus (the menu only carries the recent window);
 * what was said is found through the search route, debounced.
 *
 * What the box finds, ranks and opens is omni-search.model.ts's; this
 * component keeps the focus, the debounce, the calls and the scroll.
 */

import { useEffect, useReducer, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import { useDismiss } from '@/lib/use-dismiss';
import { chatClient } from '@/lib/chat/client';
import type { ChatSidebarData } from '@/lib/chat/sidebar';
import { matchPlaces } from '@/lib/app-index';
import { scrollToHash } from '@/lib/hash-scroll';
import { formatShortcut, matchesShortcut } from '@/lib/shortcuts';
import { usePlatform } from '@/lib/use-platform';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import {
  buildSections,
  currentArtifacts,
  currentHits,
  currentIndex,
  enterTarget,
  initialOmni,
  isSearchable,
  omniReducer,
  queryText,
  saidPending as isSaidPending,
  showing as isShowing,
  type OmniPage,
} from './omni-search.model';

export type { OmniPage };

const RESULT_ICONS = {
  chat: ICONS.chat,
  pages: ICONS.pages,
  code: ICONS.code,
  artifact: ICONS.layers,
};

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
  const platform = usePlatform();
  const searchAnchor = useCoachAnchor('nav-search');
  const router = useRouter();
  const [state, dispatch] = useReducer(omniReducer, initialOmni);
  const { query, expanded, allChats } = state;
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(state.open, ref, () => dispatch({ type: 'dismiss' }));
  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  // The whole history, once a person first reaches for the search; until
  // it arrives the menu's recent window stands in.
  const loadingAll = useRef(false);
  const loadAll = () => {
    if (allChats !== null || loadingAll.current) return;
    loadingAll.current = true;
    void chatClient.sidebar().then((result) => {
      loadingAll.current = false;
      if (result.data) dispatch({ type: 'all-chats', chats: result.data.chats });
    });
  };

  // What was said, and the artifacts that hold the words: asked of the
  // server once the box holds enough to scan, and kept only for the text
  // they were asked for, so fast typing cannot show a stale line under a
  // newer query.
  const text = queryText(state);
  const searchable = isSearchable(text);
  useEffect(() => {
    if (!searchable) return;
    const handle = setTimeout(async () => {
      const result = await chatClient.searchChats(text);
      dispatch({ type: 'said', query: text, hits: result.data?.hits ?? [] });
    }, 300);
    return () => clearTimeout(handle);
  }, [text, searchable]);
  useEffect(() => {
    if (!searchable) return;
    const handle = setTimeout(async () => {
      const result = await chatClient.findArtifacts(text);
      dispatch({ type: 'found', query: text, items: result.data?.artifacts ?? [] });
    }, 300);
    return () => clearTimeout(handle);
  }, [text, searchable]);
  const saidPending = isSaidPending(state);

  // Clicking through a result leaves the page the box was used on.
  useEffect(() => {
    dispatch({ type: 'navigated' });
  }, [pathname]);

  // Ctrl/⌘K from anywhere in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesShortcut('search', event, platform)) {
        event.preventDefault();
        inputRef.current?.focus();
        dispatch({ type: 'focus' });
        loadAll();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [allChats, platform]);

  const sections = buildSections({
    query: text,
    artifacts: currentArtifacts(state),
    pages,
    // Chat projects and code projects come in separate lists from the sidebar.
    projects: [...(chats?.projects ?? []), ...(chats?.code.projects ?? [])],
    chats: allChats ?? chats?.chats ?? [],
    hits: currentHits(state),
    places: matchPlaces(text, isOperator),
    icons: RESULT_ICONS,
  });
  const flat = sections.flatMap((section) => section.results);
  const showing = isShowing(state);
  const current = currentIndex(state, flat.length);

  const closeSearch = () => {
    dispatch({ type: 'close' });
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
          dispatch({ type: 'magnifier' });
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
        <div
          {...searchAnchor}
          className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-2.5 focus-within:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:focus-within:border-blue-700"
        >
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
              dispatch({ type: 'focus' });
              loadAll();
            }}
            onChange={(event) => dispatch({ type: 'type', value: event.target.value })}
            onKeyDown={(event) => {
              const target = enterTarget(state, flat);
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                dispatch({
                  type: 'move',
                  delta: event.key === 'ArrowDown' ? 1 : -1,
                  count: flat.length,
                });
              } else if (event.key === 'Enter' && target) {
                event.preventDefault();
                choose(target);
              } else if (event.key === 'Escape') {
                // With nothing typed, Escape leaves the box altogether.
                if (!query) inputRef.current?.blur();
                dispatch({ type: 'escape' });
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
            {formatShortcut('search', platform)}
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
                      onMouseEnter={() => dispatch({ type: 'hover', index: position })}
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
