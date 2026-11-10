'use client';

/**
 * Switching a code chat's worktree to another branch — the read-only
 * branch label in the chat's title bar (chat-title.tsx, rendered from
 * `project.branch` there, not by anything in this file) has a "Switch
 * branch" entry in the title bar's overflow menu, which opens
 * `BranchPickerModal`: the branch list and the switch POST, inside the
 * shared `Modal`, portalled to `<body>` so it answers only to the
 * viewport (modal.tsx's own header comment has this exact class of
 * clipping/overlap bug, and why the portal fixes it) — there is no
 * inline dropdown anywhere; the title bar has no reliable room for one
 * (a long branch name once rendered past its bounds, over the
 * transcript, and a wide viewport still narrows this column when the
 * code pane sits beside it), so the modal is the one way to switch, at
 * every width. It calls the chat's own route
 * (…/code/projects/[projectId]/chats/[chatId]/branch), which refuses
 * mid-turn and dirty-tree switches with a clear reason — the project
 * screen carries no branch picker or mention of one, since it is about
 * the repository as a whole, not any chat's branch.
 *
 * A switch refused for a dirty tree (branch/route.ts's 409 'dirty') used
 * to leave a person stuck — an error line with no way to actually clean
 * the tree short of asking a chat to run git. `useBranchSwitch` tracks
 * the failure's own `code` and, on 'dirty', offers "Discard changes and
 * switch" — …/code/projects/[id]/discard (git reset --hard + git clean
 * -fd on the sandbox), then the same switch retried automatically.
 *
 * What each answer leaves on screen — the refusal, the discard offer,
 * the branch shown — is branch-switcher.model.ts.
 */

import { codeProjectUrl } from '@/lib/code/urls';
import { useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { Icon, ICONS } from '@/components/icons';
import Modal from '@/components/modal';
import {
  blockedNotice,
  branchReducer,
  canPick,
  errorCodeOf,
  initialBranch,
  type HostBranch,
} from './branch-switcher.model';

/** The branch list + switch mechanics behind the modal picker. */
function useBranchSwitch(base: string, discardBase: string, branch: string | null) {
  const router = useRouter();
  const [state, dispatch] = useReducer(branchReducer, branch, initialBranch);
  // Shown immediately on a successful switch, rather than waiting on the
  // server round-trip a router.refresh() triggers — the person just
  // watched it happen. Re-synced whenever the project's own idea of the
  // branch moves for some other reason (a new chat cloning fresh, say).
  useEffect(() => dispatch({ type: 'branchChanged', branch }), [branch]);

  const load = () => {
    if (state.branches !== null) return;
    void (async () => {
      const result = await getJson<{ branches: HostBranch[] }>(base);
      if (result.data) dispatch({ type: 'loaded', branches: result.data.branches });
      else dispatch({ type: 'loadFailed', error: result.error ?? 'Branches could not be read.' });
    })();
  };

  const pick = async (name: string): Promise<boolean> => {
    if (!canPick(state, name)) return false;
    dispatch({ type: 'switchStarted' });
    const result = await sendJsonFull<{ branch: string }>(base, 'POST', { branch: name });
    if (result.error) {
      dispatch({
        type: 'switchRefused',
        branch: name,
        error: result.error,
        code: errorCodeOf(result.data),
      });
      return false;
    }
    dispatch({ type: 'switched', branch: result.data?.branch ?? name });
    router.refresh();
    return true;
  };

  const discardAndRetry = async (): Promise<boolean> => {
    const pending = state.pendingBranch;
    if (!pending) return false;
    dispatch({ type: 'discardStarted' });
    const result = await sendJsonFull(discardBase, 'POST');
    if (result.error) {
      dispatch({ type: 'discardRefused', error: result.error, code: errorCodeOf(result.data) });
      return false;
    }
    dispatch({ type: 'discarded' });
    return pick(pending);
  };

  return { ...state, load, pick, discardAndRetry };
}

/** A switch's failure, and — on a dirty tree — the way through. */
function SwitchBlockedNotice({
  notice,
  discarding,
  onDiscard,
}: {
  notice: NonNullable<ReturnType<typeof blockedNotice>>;
  discarding: boolean;
  onDiscard: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-700 dark:text-gray-300">{notice.message}</p>
      {notice.discard ? (
        <>
          <p className="text-xs text-gray-500">
            Discarding resets every tracked file to its last commit and removes every new,
            uncommitted file — anything not committed is lost. This can’t be undone.
          </p>
          <button
            type="button"
            onClick={onDiscard}
            disabled={discarding}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {notice.discard}
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The branch list and switch POST, inside the shared Modal — opened from
 * the chat title bar's overflow menu (see this file's header comment).
 */
export function BranchPickerModal({
  projectId,
  chatId,
  branch,
  onClose,
  onSwitched,
}: {
  projectId: string;
  /** The chat whose worktree is switched. */
  chatId: string;
  branch: string | null;
  onClose: () => void;
  /**
   * The modal unmounts on close, taking its own optimistic `shown` state
   * with it. The caller uses this to update whatever `branch` it passes
   * to the title bar's other, still-mounted label immediately, rather
   * than waiting on a full router.refresh() round-trip to reach it.
   */
  onSwitched?: (branch: string) => void;
}) {
  const base = `${codeProjectUrl(projectId, chatId)}/branch`;
  const discardBase = `${codeProjectUrl(projectId, chatId)}/discard`;
  const switcher = useBranchSwitch(base, discardBase, branch);
  const {
    branches,
    loadError,
    switching,
    pendingBranch,
    discarding,
    shown,
    load,
    pick,
    discardAndRetry,
  } = switcher;
  const notice = blockedNotice(switcher);
  // Mount-once: the modal is unmounted (not just hidden) on close, so
  // there is no "reopened" case to re-key this on.
  useEffect(() => {
    load();
  }, []);

  const pickAndClose = async (name: string) => {
    if (await pick(name)) {
      onSwitched?.(name);
      onClose();
    }
  };

  const discardAndClose = async () => {
    const name = pendingBranch;
    if (await discardAndRetry()) {
      if (name) onSwitched?.(name);
      onClose();
    }
  };

  return (
    <Modal title="Switch branch" onClose={onClose}>
      <div role="listbox" aria-label="Switch branch" className="max-h-80 space-y-1 overflow-y-auto">
        {loadError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {loadError}
          </p>
        ) : branches === null ? (
          <p className="text-sm text-gray-500">Loading branches…</p>
        ) : branches.length === 0 ? (
          <p className="text-sm text-gray-500">No branches.</p>
        ) : (
          branches.map((option) => (
            <button
              key={option.name}
              type="button"
              role="option"
              aria-selected={option.name === shown}
              disabled={switching}
              onClick={() => void pickAndClose(option.name)}
              className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left font-mono text-sm disabled:opacity-60 ${
                option.name === shown
                  ? 'border-blue-200 bg-blue-50 font-semibold text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200'
                  : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-gray-700 dark:hover:bg-gray-900'
              }`}
            >
              <Icon path={ICONS.gitBranch} className="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {option.name === shown ? (
                <Icon path={ICONS.check} className="h-3.5 w-3.5 shrink-0" />
              ) : null}
            </button>
          ))
        )}
      </div>
      {notice ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-950/40"
        >
          <SwitchBlockedNotice
            notice={notice}
            discarding={discarding}
            onDiscard={() => void discardAndClose()}
          />
        </div>
      ) : null}
    </Modal>
  );
}
