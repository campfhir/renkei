'use client';

/**
 * "Permissions", inside the chat's Tools dialog: every decision that
 * applies to tools in this chat — allowed or blocked here, always allowed
 * or always blocked — one row per tool with its tag and a Reset. Each tag
 * explains itself in a tip floating beside it (hover, or press to pin).
 * "Set a tool" opens a small dialog of its own: search, pick a tool,
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
  kindPhrase,
  setOptions,
  chatToolAnswerGroups,
  chatToolAnswersCount,
  chatToolAnswersReducer,
  initialChatToolAnswersState,
  pickerGroups,
  showsChatToolAnswers,
  type ChatToolAnswerRow,
  type TagGlyph,
  type TagTone,
} from './chat-tool-answers.model';

const GLYPHS: Record<TagGlyph, string> = {
  ban: ICONS.ban,
  hand: ICONS.stopHand,
  check: ICONS.check,
  'double-check': ICONS.doubleCheck,
  lock: ICONS.lock,
  question: ICONS.question,
};

const TONE_CLASSES: Record<TagTone, string> = {
  blocked: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  asks: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  allowed: 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300',
};

function tagClass(row: ChatToolAnswerRow): string {
  return TONE_CLASSES[row.tag.tone];
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
    if (state.resetting || !row.scope) return;
    dispatch({ type: 'reset-started', tool: row.name });
    const result = await chatClient.resetToolAnswer(chatId, row.name, row.scope);
    if (result.error === null) dispatch({ type: 'reset-succeeded', answers: result.data });
    else dispatch({ type: 'reset-failed', error: result.error });
  }

  async function saveBlock() {
    const tool = state.picker.selected;
    const choice = state.picker.choice;
    if (!tool || !choice || state.resetting) return;
    dispatch({ type: 'block-started', tool });
    const result = await chatClient.setTool(chatId, tool, choice.rule, choice.scope);
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
  const options = setOptions(state);
  const kind = state.answers?.kind ?? 'chat';

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
          <Icon path={ICONS.plus} className="h-3.5 w-3.5" />
          Set a tool
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
                    {row.scope ? (
                      <button
                        type="button"
                        disabled={row.disabled}
                        onClick={() => void reset(row)}
                        aria-label={`Reset ${row.label} (${row.name})`}
                        title={
                          row.scope === 'chat'
                            ? 'Take this back in this chat'
                            : 'Take this back for every chat of this kind (changes Preferences)'
                        }
                        className={smallButton}
                      >
                        <Icon
                          path={ICONS.undo}
                          className={`h-3.5 w-3.5 ${row.busy ? 'motion-safe:animate-pulse' : ''}`}
                        />
                        Reset
                      </button>
                    ) : (
                      // The project's and the organization's are changed where they live.
                      <span className="w-[4.25rem] shrink-0 text-center text-[11px] text-gray-400">
                        {row.by === 'locked' ? 'Org' : 'Project'}
                      </span>
                    )}
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
        <Modal title="Set a tool" onClose={() => dispatch({ type: 'picker-closed' })}>
          <div className="flex max-h-[70vh] flex-col gap-3 text-sm">
            <input
              type="search"
              value={state.picker.filter}
              onChange={(event) => dispatch({ type: 'picker-filter', filter: event.target.value })}
              placeholder="Search tools"
              aria-label="Search tools"
              autoComplete="off"
              autoFocus
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <div
              role="listbox"
              aria-label="Tool"
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
                    <button
                      key={tool.name}
                      type="button"
                      role="option"
                      aria-selected={tool.selected}
                      aria-label={`${tool.label} (${tool.name})`}
                      onClick={() => dispatch({ type: 'picker-select', tool: tool.name })}
                      className={`flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-left ${
                        tool.selected
                          ? 'bg-blue-100 text-blue-900 ring-1 ring-blue-400 dark:bg-blue-950/60 dark:text-blue-100 dark:ring-blue-700'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-900'
                      }`}
                    >
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
                    </button>
                  ))}
                </div>
              ))}
              {picker.more > 0 ? (
                <p className="px-1 py-1 text-xs text-gray-500">
                  {picker.more} more — type to narrow.
                </p>
              ) : null}
            </div>
            {options.chat.length > 0 ? (
              <div className="space-y-2">
                {(
                  [
                    { key: 'chat', title: 'This chat', items: options.chat },
                    {
                      key: 'always',
                      title: `Always, in ${kindPhrase(kind)}`,
                      items: options.always,
                    },
                  ] as const
                ).map((row) => (
                  <fieldset key={row.key} className="flex flex-wrap items-center gap-2">
                    <legend className="mb-1 w-full text-xs font-medium text-gray-600 dark:text-gray-400">
                      {row.title}
                    </legend>
                    {row.items.map((option) => (
                      <label
                        key={`${option.scope}-${option.rule}`}
                        className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                          option.chosen
                            ? 'border-blue-400 bg-blue-50 text-blue-800 dark:border-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
                            : 'border-gray-300 text-gray-700 dark:border-gray-700 dark:text-gray-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`set-tool-${chatId}`}
                          className="sr-only"
                          checked={option.chosen}
                          onChange={() =>
                            dispatch({
                              type: 'picker-choice',
                              scope: option.scope,
                              rule: option.rule,
                            })
                          }
                        />
                        <Icon
                          path={GLYPHS[option.glyph]}
                          solid={option.glyph === 'hand'}
                          className={`h-3.5 w-3.5 ${
                            option.rule === 'deny'
                              ? 'text-red-600 dark:text-red-400'
                              : option.rule === 'ask'
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-green-600 dark:text-green-400'
                          }`}
                        />
                        {option.label}
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Pick a tool to choose what it may do.
              </p>
            )}
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
