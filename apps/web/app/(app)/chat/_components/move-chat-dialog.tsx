'use client';

/**
 * "Move to project": a chat into one of the person's chat projects, or
 * back out to none. Opened from a chat row's ⋯ menu in the sidebar (which
 * hands in the projects it already has) and from the open chat's own ⋯
 * menu (which lets the dialog load them). The rules are
 * move-chat-dialog.model.ts's; the server's are the move route's.
 */

import { useEffect, useReducer } from 'react';
import Modal from '@/components/modal';
import { chatClient } from '@/lib/chat/client';
import type { ProjectListItem } from '@/lib/chat/sidebar';
import {
  initialMoveChat,
  moveChatReducer,
  moveEmptyNote,
  moveTargets,
} from './move-chat-dialog.model';

export default function MoveChatDialog({
  chatId,
  currentProjectId,
  projects = null,
  onMoved,
  onClose,
}: {
  chatId: string;
  currentProjectId: string | null;
  /** The chat projects to offer; loaded when the dialog opens if not given. */
  projects?: ProjectListItem[] | null;
  /** The project the chat is now in (its id and name), or null for none. */
  onMoved: (project: { id: string; name: string } | null) => void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(moveChatReducer, projects, initialMoveChat);
  const loaded = state.projects !== null;

  useEffect(() => {
    if (loaded) return;
    let live = true;
    void chatClient.listProjects().then((result) => {
      if (!live) return;
      if (result.error || !result.data) {
        dispatch({ type: 'projectsFailed', error: result.error ?? 'Projects could not load.' });
      } else {
        dispatch({ type: 'projectsLoaded', projects: result.data.projects });
      }
    });
    return () => {
      live = false;
    };
  }, [loaded]);

  const move = async (projectId: string | null) => {
    if (state.moving !== undefined) return;
    dispatch({ type: 'moveStarted', projectId });
    const result = await chatClient.moveChat(chatId, projectId);
    if (result.error) {
      dispatch({ type: 'moveFailed', error: result.error });
      return;
    }
    dispatch({ type: 'moved' });
    const project = state.projects?.find((option) => option.id === projectId);
    onMoved(project ? { id: project.id, name: project.name } : null);
  };

  const note = moveEmptyNote(state);
  return (
    <Modal title="Move to project" onClose={onClose}>
      <div className="space-y-1">
        {moveTargets(state, currentProjectId).map((target) => (
          <button
            key={target.projectId ?? 'none'}
            type="button"
            disabled={target.disabled}
            aria-current={target.current ? 'true' : undefined}
            onClick={() => void move(target.projectId)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800"
          >
            <span className="min-w-0 flex-1 truncate">{target.label}</span>
            {target.current ? (
              <span className="shrink-0 text-xs text-gray-500">current</span>
            ) : null}
            {state.moving === target.projectId ? (
              <span className="shrink-0 text-xs text-gray-500">Moving…</span>
            ) : null}
          </button>
        ))}
        {note ? <p className="px-3 text-sm text-gray-500">{note}</p> : null}
        {state.error ? <p className="px-3 text-sm text-red-600">{state.error}</p> : null}
      </div>
    </Modal>
  );
}
