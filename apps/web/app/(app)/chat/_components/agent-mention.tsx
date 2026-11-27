'use client';

/**
 * The composer's agent addressing (agent-mention.model.ts): `@` or the
 * "Ask an agent" button opens a list of the person's agents over the box,
 * the project's team first; a pick puts a "To …" chip over the box and
 * the next Send goes to that agent. The list portals to <body> and sits
 * above the box (lib/floating.ts), like the code composer's path list.
 */

import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, ICONS } from '@/components/icons';
import { useFloating } from '@/lib/floating';
import { chatClient } from '@/lib/chat/client';
import type { AskableAgent } from '@/lib/chat/agent-ask-view';
import {
  activeOption,
  addresseeChip,
  agentMentionReducer,
  initialAgentMention,
  mentionHint,
  mentionOpen,
  mentionOptions,
  optionNote,
  textAfterPick,
  type AgentMentionState,
} from './agent-mention.model';

/** A request from outside the composer (an agent card's Reply) to address the next message. */
export interface AddressRequest {
  agent: AskableAgent;
  /** Bumped per press, so pressing Reply twice on the same card still lands. */
  nonce: number;
}

export function useAgentMention({
  enabled,
  projectId,
  textareaRef,
  text,
  setText,
  addressRequest,
  preferAgentId = null,
}: {
  /** Off in a code project's chat (its `@` completes paths) and wherever agents are not offered. */
  enabled: boolean;
  projectId: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  addressRequest: AddressRequest | null;
  /** Address the message to this agent once the list shows the person may ask it (`?agent=`). */
  preferAgentId?: string | null;
}): {
  state: AgentMentionState;
  sent: () => void;
  overlay: ReactNode;
  chip: ReactNode;
  button: ReactNode;
  hint: string | null;
  listboxId: string;
  activeId: string | undefined;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  refresh: () => void;
} {
  const [state, dispatch] = useReducer(agentMentionReducer, initialAgentMention);
  const listboxId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const caretAfter = useRef<number | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void chatClient.askableAgents(projectId).then((result) => {
      if (live && result.data) dispatch({ type: 'agentsLoaded', agents: result.data.agents });
    });
    return () => {
      live = false;
    };
  }, [enabled, projectId]);

  const preferred = useRef<string | null>(null);
  useEffect(() => {
    if (!preferAgentId || preferred.current === preferAgentId || !state.agents) return;
    preferred.current = preferAgentId;
    const agent = state.agents.find((candidate) => candidate.id === preferAgentId);
    if (agent) {
      dispatch({ type: 'addressed', agent });
      textareaRef.current?.focus();
    }
  }, [preferAgentId, state.agents, textareaRef]);

  useEffect(() => {
    if (addressRequest) {
      dispatch({ type: 'addressed', agent: addressRequest.agent });
      textareaRef.current?.focus();
    }
  }, [addressRequest, textareaRef]);

  const refresh = useCallback(() => {
    const element = textareaRef.current;
    if (!enabled || !element) return;
    dispatch({ type: 'caretMoved', text, caret: element.selectionStart ?? text.length });
  }, [enabled, textareaRef, text]);
  useEffect(refresh, [refresh]);

  // After a pick the caret goes back where the `@` was.
  useEffect(() => {
    if (caretAfter.current === null) return;
    const element = textareaRef.current;
    const position = caretAfter.current;
    caretAfter.current = null;
    if (!element) return;
    element.focus();
    element.setSelectionRange(position, position);
  }, [text, textareaRef]);

  const open = enabled && mentionOpen(state);
  const box = useFloating(open, textareaRef, boxRef, { align: 'start', prefer: 'above', gap: 6 });
  useEffect(() => {
    if (!open) return;
    const measure = () => setWidth(textareaRef.current?.getBoundingClientRect().width ?? null);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, textareaRef]);

  const pick = useCallback(
    (agent: AskableAgent) => {
      const next = textAfterPick(text, state.mention);
      if (next.text !== text) setText(next.text);
      caretAfter.current = next.caret;
      dispatch({ type: 'picked', agent });
      if (next.caret === null) textareaRef.current?.focus();
    },
    [text, state.mention, setText, textareaRef]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      dispatch({ type: 'dismissed' });
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      dispatch({ type: 'moved', by: event.key === 'ArrowDown' ? 1 : -1 });
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      const agent = activeOption(state);
      if (!agent) return false;
      event.preventDefault();
      pick(agent);
      return true;
    }
    return false;
  };

  const options = mentionOptions(state);
  const optionId = (index: number) => `${listboxId}-agent-${index}`;
  const overlay =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={boxRef}
            role="listbox"
            id={listboxId}
            aria-label="Agents you can ask"
            data-agent-mention
            style={{
              position: 'fixed',
              top: box?.top ?? 0,
              left: box?.left ?? 0,
              // Never past the room beside the box — above an iOS keyboard, little.
              maxHeight: box ? `min(18rem, ${box.maxHeight}px)` : undefined,
              width: width ?? undefined,
              visibility: box ? 'visible' : 'hidden',
            }}
            className="z-40 max-h-72 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg ring-1 ring-black/5 dark:border-gray-700 dark:bg-gray-900 dark:ring-white/10"
          >
            <p className="px-3 pb-1 pt-0.5 text-[11px] text-gray-500">
              Hand a task to an agent — it works in the background and replies here.
            </p>
            {options.length === 0 ? (
              <p className="px-3 py-1.5 text-xs text-gray-500">
                No agent matches “{state.mention?.query}”.
              </p>
            ) : (
              options.map((agent, index) => {
                const isActive = index === state.active;
                const note = optionNote(agent);
                return (
                  <div
                    key={agent.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isActive}
                    // mousedown would take the focus (and the caret) from the box.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(agent)}
                    className={`flex cursor-pointer items-start gap-2 px-3 py-1.5 ${
                      isActive
                        ? 'bg-indigo-50 text-gray-900 dark:bg-indigo-950/50 dark:text-gray-100'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <Icon
                      path={ICONS.agent}
                      className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500 dark:text-indigo-400"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{agent.name}</span>
                      {note ? (
                        <span className="block truncate text-xs text-gray-500">{note}</span>
                      ) : null}
                    </span>
                  </div>
                );
              })
            )}
          </div>,
          document.body
        )
      : null;

  const chip =
    enabled && state.addressee ? (
      <div className="flex px-3 pt-2">
        <span
          data-agent-addressee
          className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 py-0.5 pl-2 pr-1 text-xs font-medium text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200"
        >
          <Icon path={ICONS.agent} className="h-3.5 w-3.5" />
          {addresseeChip(state.addressee).label}
          <button
            type="button"
            onClick={() => dispatch({ type: 'cleared' })}
            aria-label={addresseeChip(state.addressee).clear}
            className="rounded-full p-0.5 hover:bg-indigo-100 dark:hover:bg-indigo-900"
          >
            <Icon path={ICONS.close} className="h-3 w-3" />
          </button>
        </span>
      </div>
    ) : null;

  const button =
    enabled && state.agents && state.agents.length > 0 ? (
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          dispatch({ type: 'browseToggled' });
          textareaRef.current?.focus();
        }}
        aria-label="Ask an agent"
        aria-expanded={open}
        title="Ask one of your agents — hand it a task and it replies here"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        <Icon path={ICONS.agent} className="h-5 w-5" />
        <span className="hidden sm:inline">Ask an agent</span>
      </button>
    ) : null;

  return {
    state,
    sent: () => dispatch({ type: 'sent' }),
    overlay,
    chip,
    button,
    hint: enabled ? mentionHint(state) : null,
    listboxId,
    activeId: open && options.length > 0 ? optionId(state.active) : undefined,
    onKeyDown,
    refresh,
  };
}
