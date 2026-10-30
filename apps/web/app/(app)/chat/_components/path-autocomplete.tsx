'use client';

/**
 * `@` in a code project's composer completes a path in the repository.
 * Typing `@` opens a small list over (or, when the box is near the top
 * of the window, under) the box; what is typed after it narrows the
 * list, each row showing where the typed text falls in its path; ↑↓
 * move, Enter or Tab take the row, Escape puts the list away until the
 * next `@`. Taking a row leaves `@path ` in the box — the model reads
 * it as any mention, and the chat's code tools know the path.
 *
 * The paths come from `…/code/projects/[id]/chats/[chatId]/find?q=`
 * (the checkout's own files once there is a checkout, the repository's
 * top level from its git host before that), asked for a beat after the
 * last keystroke and answered in order — an older answer never
 * overwrites a newer one. The list is portalled to <body> and placed
 * with `position: fixed` (lib/floating.ts): it sits above the box
 * when there is room there, which at the bottom of a chat there is,
 * and below it otherwise.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, ICONS } from '@/components/icons';
import { Spinner } from '@/components/skeleton';
import { getJson } from '@/lib/fetch-json';
import { codeProjectUrl } from '@/lib/code/urls';
import { useFloating } from '@/lib/floating';

export interface PathCompletionScope {
  projectId: string;
  chatId: string;
}

interface Mention {
  /** Where the `@` is in the text. */
  start: number;
  /** What follows it, up to the caret. */
  query: string;
  /** The caret, so the replacement knows where the query ends. */
  end: number;
}

const DEBOUNCE_MS = 120;

/** The `@` the caret is in, if it is in one: `@` at a word's start, no space since. */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query, end: caret };
}

/** The path split around the first place the query occurs, for highlighting. */
export function splitMatch(path: string, query: string): [string, string, string] {
  if (!query) return [path, '', ''];
  const index = path.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return [path, '', ''];
  return [path.slice(0, index), path.slice(index, index + query.length), path.slice(index + query.length)];
}

export function usePathCompletions({
  scope,
  textareaRef,
  text,
  setText,
}: {
  scope: PathCompletionScope | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
}): {
  open: boolean;
  listboxId: string;
  activeId: string | undefined;
  /** The list, rendered beside the textarea (it portals itself). */
  overlay: ReactNode;
  /** True when the key was the list's — the caller does nothing more with it. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The caret moved without the text changing (a click, an arrow): look again. */
  refresh: () => void;
}
{
  const listboxId = useId();
  const [mention, setMention] = useState<Mention | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  /** The `@` Escape put away: nothing shows for it until the caret leaves it. */
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const requests = useRef(0);
  const caretAfter = useRef<number | null>(null);

  const detect = useCallback(() => {
    const element = textareaRef.current;
    if (!scope || !element) {
      setMention(null);
      return;
    }
    const caret = element.selectionStart ?? text.length;
    const next = mentionAt(text, caret);
    setMention((current) =>
      current && next && current.start === next.start && current.query === next.query && current.end === next.end
        ? current
        : next
    );
  }, [scope, textareaRef, text]);

  useEffect(detect, [detect]);
  useEffect(() => {
    if (!mention || dismissedStart === mention.start) return;
    if (dismissedStart !== null) setDismissedStart(null);
  }, [mention, dismissedStart]);

  // Ask a beat after the last keystroke; keep only the newest answer.
  useEffect(() => {
    if (!mention || !scope) {
      setItems([]);
      setLoading(false);
      return;
    }
    const request = ++requests.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void getJson<{ paths: string[]; truncated: boolean }>(
        `${codeProjectUrl(scope.projectId, scope.chatId)}/find?q=${encodeURIComponent(mention.query)}`
      ).then((result) => {
        if (request !== requests.current) return;
        setLoading(false);
        setItems(result.data?.paths ?? []);
        setTruncated(result.data?.truncated ?? false);
        setActive(0);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [mention, scope]);

  const open = mention !== null && dismissedStart !== mention.start && (loading || items.length > 0 || mention.query.length > 0);
  const box = useFloating(open, textareaRef, boxRef, { align: 'start', prefer: 'above', gap: 6 });

  useEffect(() => {
    if (!open) return;
    const measure = () => setWidth(textareaRef.current?.getBoundingClientRect().width ?? null);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, textareaRef]);

  // After a pick the caret goes right after the inserted path.
  useEffect(() => {
    if (caretAfter.current === null) return;
    const element = textareaRef.current;
    const position = caretAfter.current;
    caretAfter.current = null;
    if (!element) return;
    element.focus();
    element.setSelectionRange(position, position);
  }, [text, textareaRef]);

  const accept = useCallback(
    (path: string) => {
      if (!mention) return;
      const inserted = `@${path} `;
      setText(text.slice(0, mention.start) + inserted + text.slice(mention.end));
      caretAfter.current = mention.start + inserted.length;
      setMention(null);
      setItems([]);
    },
    [mention, text, setText]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (mention) setDismissedStart(mention.start);
      return true;
    }
    if (items.length === 0) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % items.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + items.length) % items.length);
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      accept(items[active] ?? items[0]!);
      return true;
    }
    return false;
  };

  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const overlay =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={boxRef}
            role="listbox"
            id={listboxId}
            aria-label="Files matching"
            data-placement={box?.placement}
            style={{
              position: 'fixed',
              top: box?.top ?? 0,
              left: box?.left ?? 0,
              width: width ?? undefined,
              visibility: box ? 'visible' : 'hidden',
            }}
            className="z-40 max-h-64 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg ring-1 ring-black/5 dark:border-gray-700 dark:bg-gray-900 dark:ring-white/10"
          >
            {items.length === 0 ? (
              <p className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-500">
                {loading ? (
                  <>
                    <Spinner size={3} /> Searching…
                  </>
                ) : (
                  <>No files match “{mention?.query}”.</>
                )}
              </p>
            ) : (
              items.map((path, index) => {
                const [before, hit, after] = splitMatch(path, mention?.query ?? '');
                const isActive = index === active;
                return (
                  <div
                    key={path}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isActive}
                    // mousedown would take the focus (and the caret) from the box.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => accept(path)}
                    className={`flex cursor-pointer items-center gap-2 px-3 py-1 font-mono text-xs ${
                      isActive
                        ? 'bg-blue-50 text-gray-900 dark:bg-blue-950/50 dark:text-gray-100'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <Icon path={ICONS.file} className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span className="min-w-0 flex-1 truncate">
                      {before}
                      {hit ? (
                        <mark className="rounded-sm bg-yellow-200 px-px font-semibold text-gray-900 dark:bg-yellow-500/40 dark:text-gray-100">
                          {hit}
                        </mark>
                      ) : null}
                      {after}
                    </span>
                  </div>
                );
              })
            )}
            {items.length > 0 ? (
              <p className="px-3 pt-1 text-[11px] text-gray-400">
                {truncated ? 'More match — keep typing to narrow it. ' : ''}↑↓ then Enter
              </p>
            ) : null}
          </div>,
          document.body
        )
      : null;

  return {
    open,
    listboxId,
    activeId: open && items.length > 0 ? optionId(active) : undefined,
    overlay,
    onKeyDown,
    refresh: detect,
  };
}
