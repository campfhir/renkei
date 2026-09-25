'use client';

/**
 * Switching the active chat's project's checkout branch — the read-only
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
 * every width. A history chat gets no "Switch branch" entry at all,
 * since it can no longer send turns and switching a checkout nobody
 * can act on next is pointless. Both this and the project screen call
 * the same route (…/code/projects/[projectId]/branch), which refuses
 * mid-turn and dirty-tree switches with a clear reason — the project
 * screen itself carries no branch picker or mention of one, since it is
 * about the repository as a whole, not the checkout's current branch.
 *
 * A switch refused for a dirty tree (branch/route.ts's 409 'dirty') used
 * to leave a person stuck — an error line with no way to actually clean
 * the tree short of asking a chat to run git. `useBranchSwitch` tracks
 * the failure's own `code` and, on 'dirty', offers "Discard changes and
 * switch" — …/code/projects/[id]/discard (git reset --hard + git clean
 * -fd on the sandbox), then the same switch retried automatically.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import Modal from '@/components/modal';

interface HostBranch {
  name: string;
  headSha: string;
}

function errorCodeOf(data: unknown): string | null {
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null;
}

/** The branch list + switch mechanics behind the modal picker. */
function useBranchSwitch(base: string, discardBase: string, branch: string | null) {
  const router = useRouter();
  const [branches, setBranches] = useState<HostBranch[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchErrorCode, setSwitchErrorCode] = useState<string | null>(null);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // Shown immediately on a successful switch, rather than waiting on the
  // server round-trip a router.refresh() triggers — the person just
  // watched it happen. Re-synced whenever the project's own idea of the
  // branch moves for some other reason (a new chat cloning fresh, say).
  const [shown, setShown] = useState(branch);
  useEffect(() => setShown(branch), [branch]);

  const load = () => {
    if (branches !== null) return;
    void (async () => {
      const result = await getJson<{ branches: HostBranch[] }>(base);
      if (result.data) setBranches(result.data.branches);
      else setLoadError(result.error ?? 'Branches could not be read.');
    })();
  };

  const pick = async (name: string): Promise<boolean> => {
    if (name === shown || switching) return false;
    setSwitching(true);
    setSwitchError(null);
    setSwitchErrorCode(null);
    const result = await sendJsonFull<{ branch: string }>(base, 'POST', { branch: name });
    setSwitching(false);
    if (result.error) {
      setSwitchError(result.error);
      const code = errorCodeOf(result.data);
      setSwitchErrorCode(code);
      setPendingBranch(code === 'dirty' ? name : null);
      return false;
    }
    setShown(result.data?.branch ?? name);
    setBranches(null);
    setPendingBranch(null);
    router.refresh();
    return true;
  };

  const discardAndRetry = async (): Promise<boolean> => {
    if (!pendingBranch) return false;
    setDiscarding(true);
    const result = await sendJsonFull(discardBase, 'POST');
    setDiscarding(false);
    if (result.error) {
      setSwitchError(result.error);
      setSwitchErrorCode(errorCodeOf(result.data));
      return false;
    }
    return pick(pendingBranch);
  };

  return {
    branches,
    loadError,
    switching,
    switchError,
    switchErrorCode,
    pendingBranch,
    discarding,
    shown,
    load,
    pick,
    discardAndRetry,
  };
}

/** A switch's failure, and — on a dirty tree — the way through. */
function SwitchBlockedNotice({
  code,
  message,
  branchName,
  discarding,
  onDiscard,
}: {
  code: string;
  message: string | null;
  branchName: string | null;
  discarding: boolean;
  onDiscard: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-700 dark:text-gray-300">{message}</p>
      {code === 'dirty' && branchName ? (
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
            {discarding ? 'Discarding…' : `Discard changes and switch to ${branchName}`}
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
  tenantId,
  projectId,
  branch,
  onClose,
  onSwitched,
}: {
  tenantId: string;
  projectId: string;
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
  const base = `/api/tenant/${tenantId}/code/projects/${projectId}/branch`;
  const discardBase = `/api/tenant/${tenantId}/code/projects/${projectId}/discard`;
  const {
    branches,
    loadError,
    switching,
    switchError,
    switchErrorCode,
    pendingBranch,
    discarding,
    shown,
    load,
    pick,
    discardAndRetry,
  } = useBranchSwitch(base, discardBase, branch);
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
      <div role="listbox" aria-label="Switch branch" className="max-h-80 space-y-0.5 overflow-y-auto">
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
              className={`block w-full truncate rounded-md px-3 py-2 text-left font-mono text-sm hover:bg-gray-100 disabled:opacity-60 dark:hover:bg-gray-900 ${
                option.name === shown ? 'font-semibold' : ''
              }`}
            >
              {option.name}
            </button>
          ))
        )}
      </div>
      {switchErrorCode ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-950/40"
        >
          <SwitchBlockedNotice
            code={switchErrorCode}
            message={switchError}
            branchName={pendingBranch}
            discarding={discarding}
            onDiscard={() => void discardAndClose()}
          />
        </div>
      ) : null}
    </Modal>
  );
}
