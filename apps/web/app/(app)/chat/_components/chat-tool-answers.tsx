'use client';

/**
 * "Permissions", inside the chat's Tools dialog: every decision that
 * applies to tools in this chat — allowed or blocked here, always allowed
 * or always blocked — one row per tool with its tag and a Reset. Each tag
 * explains itself in a tip floating beside it (hover, or press to pin).
 * "Block a tool" opens a small dialog of its own: search, pick a tool,
 * this chat or every chat, Save — the tool joins the list. That is how a
 * tool that only reads gets blocked: it never asks, so no card offers it.
 * Loaded each time the dialog opens. The rules are
 * chat-tool-answers.model.ts's.
 */

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Modal from '@/components/modal';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import {
  blockSave,
  chatToolAnswerGroups,
  chatToolAnswersCount,
  chatToolAnswersReducer,
  initialChatToolAnswersState,
  pickerGroups,
  showsChatToolAnswers,
  type ChatToolAnswerRow,
  type TagGlyph,
} from './chat-tool-answers.model';

const GLYPHS: Record<TagGlyph, string> = {
  ban: ICONS.ban,
  hand: ICONS.stopHand,
  check: ICONS.check,
  'double-check': ICONS.doubleCheck,
  lock: ICONS.lock,
};

function tagClass(row: ChatToolAnswerRow): string {
  if (row.blocked) return 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300';
  if (row.locked) return 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300';
  return 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300';
}

const smallButton =
  'inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-300 px-1.5 py-0.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800';

/**
 * A tip floating beside its anchor, drawn at <body> so the list's own
 * scrolling box cannot clip it and it covers rows rather than pushing
 * them: below the anchor, right edges aligned, or above it when there is
 * no room below. Follows the anchor while anything scrolls.
 */
function FloatingTip({
  anchor,
  id,
  text,
}: {
  anchor: HTMLElement | null;
  id: string;
  text: string;
}) {
  const [place, setPlace] = useState<{ top: number; right: number; above: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const measure = () => {
      const box = anchor.getBoundingClientRect();
      const above = box.bottom + 90 > window.innerHeight;
      setPlace({
        top: above ? box.top - 6 : box.bottom + 6,
        right: Math.max(8, window.innerWidth - box.right),
        above,
      });
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [anchor]);
  if (!anchor || !place) return null;
  return createPortal(
    <div
      id={id}
      role="tooltip"
      style={{
        top: place.top,
        right: place.right,
        transform: place.above ? 'translateY(-100%)' : undefined,
      }}
      className="pointer-events-none fixed z-[60] max-w-64 rounded-md bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-gray-100 dark:text-gray-900"
    >
      {text}
    </div>,
    document.body
  );
}

export default function ChatToolAnswers({ chatId }: { chatId: string }) {
  const [state, dispatch] = useReducer(chatToolAnswersReducer, initialChatToolAnswersState);
  // Hovering or focusing a tag shows its tip; pressing pins it (the model's `explaining`).
  const [hovered, setHovered] = useState<string | null>(null);
  const tagRefs = useRef(new Map<string, HTMLButtonElement>());
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    void chatClient.toolAnswers(chatId).then((result) => {
      if (!live) return;
      if (result.data) dispatch({ type: 'loaded', answers: result.data });
      else dispatch({ type: 'load-failed' });
    });
    return () => {
      live = false;
    };
  }, [chatId]);

  // A pinned tip lets go on Escape or a press anywhere else.
  const pinned = state.explaining;
  useEffect(() => {
    if (!pinned) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dispatch({ type: 'explain', tool: pinned });
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && tagRefs.current.get(pinned)?.contains(event.target)) {
        return;
      }
      dispatch({ type: 'explain', tool: pinned });
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [pinned]);

  async function reset(row: ChatToolAnswerRow) {
    if (state.resetting) return;
    dispatch({ type: 'reset-started', tool: row.name });
    const result = await chatClient.resetToolAnswer(chatId, row.name, row.scope);
    if (result.error === null) dispatch({ type: 'reset-succeeded', answers: result.data });
    else dispatch({ type: 'reset-failed', error: result.error });
  }

  async function saveBlock() {
    const tool = state.picker.selected;
    if (!tool || state.resetting) return;
    dispatch({ type: 'block-started', tool });
    const result = await chatClient.blockTool(chatId, tool, state.picker.scope);
    if (result.error === null) dispatch({ type: 'reset-succeeded', answers: result.data });
    else dispatch({ type: 'reset-failed', error: result.error });
  }

  if (!showsChatToolAnswers(state)) return null;
  const count = chatToolAnswersCount(state);
  const groups = chatToolAnswerGroups(state);
  const tipFor = hovered ?? pinned;
  const tipRow = tipFor
    ? groups.flatMap((group) => group.rows).find((r) => r.name === tipFor)
    : null;
  const picker = state.picker.open ? pickerGroups(state) : null;
  const save = blockSave(state);

  return (
    <section
      ref={sectionRef}
      aria-labelledby="chat-tool-answers-heading"
      className="mt-3 shrink-0 rounded-md border border-gray-200 dark:border-gray-800"
    >
      <div className="flex items-center gap-2 border-b border-gray-200 px-2 py-1.5 dark:border-gray-800">
        <h3 id="chat-tool-answers-heading" className="text-sm font-medium">
          Permissions
        </h3>
        {count ? <span className="text-xs text-gray-500 dark:text-gray-400">{count}</span> : null}
        <button
          type="button"
          onClick={() => dispatch({ type: 'picker-opened' })}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-gray-300 px-1.5 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <Icon path={ICONS.ban} className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
          Block a tool
        </button>
      </div>
      {groups.length > 0 ? (
        <div className="max-h-48 overflow-y-auto p-1">
          {groups.map((group) => (
            <div key={group.key} role="group" aria-label={group.label}>
              <p className="px-1.5 pt-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
                {group.label}
              </p>
              <ul>
                {group.rows.map((row) => (
                  <li
                    key={row.name}
                    className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-900"
                  >
                    <span className="min-w-0 flex-1 truncate" title={row.name}>
                      {row.label}
                    </span>
                    <button
                      type="button"
                      ref={(element) => {
                        if (element) tagRefs.current.set(row.name, element);
                        else tagRefs.current.delete(row.name);
                      }}
                      aria-describedby={tipFor === row.name ? `tool-tip-${row.name}` : undefined}
                      aria-pressed={row.explained}
                      onMouseEnter={() => setHovered(row.name)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(row.name)}
                      onBlur={() => setHovered(null)}
                      onClick={() => dispatch({ type: 'explain', tool: row.name })}
                      className={`inline-flex shrink-0 cursor-help items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${tagClass(row)}`}
                    >
                      <Icon
                        path={GLYPHS[row.tag.glyph]}
                        solid={row.tag.glyph === 'hand'}
                        className="h-3.5 w-3.5"
                      />
                      {row.tag.text}
                    </button>
                    <button
                      type="button"
                      disabled={row.disabled}
                      onClick={() => void reset(row)}
                      aria-label={`Reset ${row.label} (${row.name})`}
                      title={
                        row.scope === 'chat'
                          ? 'Take this back in this chat'
                          : 'Take this back in every chat (changes Preferences)'
                      }
                      className={smallButton}
                    >
                      <Icon
                        path={ICONS.undo}
                        className={`h-3.5 w-3.5 ${row.busy ? 'motion-safe:animate-pulse' : ''}`}
                      />
                      Reset
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      <p className="border-t border-gray-200 px-2 py-1 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
        Anything not listed asks first.
      </p>
      {state.error && !state.picker.open ? (
        <p className="px-2 pb-1.5 text-xs text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}

      {tipRow ? (
        <FloatingTip
          anchor={tagRefs.current.get(tipRow.name) ?? null}
          id={`tool-tip-${tipRow.name}`}
          text={tipRow.tag.meaning}
        />
      ) : null}

      {picker ? (
        <Modal title="Block a tool" onClose={() => dispatch({ type: 'picker-closed' })}>
          <div className="flex max-h-[70vh] flex-col gap-3 text-sm">
            <input
              type="search"
              value={state.picker.filter}
              onChange={(event) => dispatch({ type: 'picker-filter', filter: event.target.value })}
              placeholder="Search tools"
              aria-label="Search tools to block"
              autoComplete="off"
              autoFocus
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <div
              role="radiogroup"
              aria-label="Tool to block"
              className="min-h-0 flex-1 overflow-y-auto rounded-md border border-gray-200 p-1 dark:border-gray-800"
            >
              {picker.groups.length === 0 ? (
                <p className="px-1 py-1 text-xs text-gray-500">No tool matches.</p>
              ) : null}
              {picker.groups.map((group) => (
                <div key={group.key}>
                  <p className="px-1.5 pt-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase dark:text-gray-400">
                    {group.label}
                  </p>
                  {group.tools.map((tool) => (
                    <label
                      key={tool.name}
                      className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 ${
                        tool.selected
                          ? 'bg-blue-50 dark:bg-blue-950/50'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-900'
                      }`}
                    >
                      <input
                        type="radio"
                        name={`block-tool-${chatId}`}
                        checked={tool.selected}
                        onChange={() => dispatch({ type: 'picker-select', tool: tool.name })}
                        aria-label={`${tool.label} (${tool.name})`}
                      />
                      <span className="min-w-0 flex-1 truncate" title={tool.name}>
                        {tool.label}
                      </span>
                      {tool.read ? (
                        <span
                          className="shrink-0 rounded bg-gray-100 px-1 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                          title="Only reads: it never asks, so blocking it here is the way to stop it"
                        >
                          reads
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              ))}
              {picker.more > 0 ? (
                <p className="px-1 py-1 text-xs text-gray-500">
                  {picker.more} more — type to narrow.
                </p>
              ) : null}
            </div>
            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">Where</legend>
              {(
                [
                  { scope: 'chat', label: 'This chat', glyph: ICONS.ban, solid: false },
                  { scope: 'always', label: 'Every chat', glyph: ICONS.stopHand, solid: true },
                ] as const
              ).map((option) => (
                <label
                  key={option.scope}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                    state.picker.scope === option.scope
                      ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200'
                      : 'border-gray-300 text-gray-700 dark:border-gray-700 dark:text-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name={`block-scope-${chatId}`}
                    className="sr-only"
                    checked={state.picker.scope === option.scope}
                    onChange={() => dispatch({ type: 'picker-scope', scope: option.scope })}
                  />
                  <Icon
                    path={option.glyph}
                    solid={option.solid}
                    className="h-3.5 w-3.5 text-red-600 dark:text-red-400"
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            {state.error ? (
              <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                {state.error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
              <button
                type="button"
                onClick={() => dispatch({ type: 'picker-closed' })}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={save.disabled}
                onClick={() => void saveBlock()}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {save.label}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
