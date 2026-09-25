'use client';

/**
 * The project's shared checkout branch, and — for someone who can change
 * it — a small combobox to switch it: on the project screen's Repository
 * card, and beside the read-only branch label in the active chat's title
 * bar (chat-title.tsx; a history chat keeps the plain label, since it can
 * no longer send turns and switching a checkout nobody can act on next
 * is pointless). Both call the same route
 * (…/code/projects/[projectId]/branch), which refuses mid-turn and
 * dirty-tree switches with a clear reason.
 *
 * The chat title bar is too cramped on a phone for this component's own
 * anchored dropdown — a long branch name there forced the trigger past
 * the header's bounds, rendering over the transcript beneath it. Below
 * `lg`, chat-thread.tsx swaps this for the plain read-only label plus a
 * "Switch branch" entry in the title bar's overflow menu, which opens
 * `BranchPickerModal` (also exported here) — the same list and POST,
 * inside the shared `Modal`, portalled to `<body>` so it answers only to
 * the viewport (modal.tsx's own header comment has this exact class of
 * clipping/overlap bug, and why the portal fixes it).
 *
 * A switch refused for a dirty tree (branch/route.ts's 409 'dirty') used
 * to leave a person stuck — an error line with no way to actually clean
 * the tree short of asking a chat to run git. `useBranchSwitch` now
 * tracks the failure's own `code` and, on 'dirty', offers
 * "Discard changes and switch" — …/code/projects/[id]/discard
 * (git reset --hard + git clean -fd on the sandbox), then the same
 * switch retried automatically.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { Icon, ICONS } from '@/components/icons';
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

/** The branch list + switch mechanics, shared by the inline dropdown and the modal picker. */
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

  const clearSwitchError = () => {
    setSwitchError(null);
    setSwitchErrorCode(null);
    setPendingBranch(null);
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
    clearSwitchError,
  };
}

/**
 * A switch's failure, and — on a dirty tree — the way through: the
 * caller wraps this in whatever chrome fits (a Modal for the inline
 * dropdown, an inline bordered block for the already-modal mobile
 * picker).
 */
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

export default function BranchSwitcher({
  tenantId,
  projectId,
  branch,
  canSwitch,
  className = '',
  reason,
}: {
  tenantId: string;
  projectId: string;
  branch: string | null;
  canSwitch: boolean;
  className?: string;
  /** Shown as a tooltip when `canSwitch` is false, so the plain label
   * doesn't read as "this feature doesn't exist" — it explains what's
   * missing (no checkout yet, no edit access) instead of staying silent. */
  reason?: string;
}) {
  const base = `/api/tenant/${tenantId}/code/projects/${projectId}/branch`;
  const discardBase = `/api/tenant/${tenantId}/code/projects/${projectId}/discard`;
  const [open, setOpen] = useState(false);
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
    clearSwitchError,
  } = useBranchSwitch(base, discardBase, branch);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) load();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (event: MouseEvent) => {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  const pickAndClose = async (name: string) => {
    if (await pick(name)) setOpen(false);
  };

  if (!canSwitch) {
    return (
      <span className={`inline-flex min-w-0 items-center gap-1 font-mono ${className}`} title={reason}>
        <Icon path={ICONS.gitBranch} className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{shown || 'default branch'}</span>
      </span>
    );
  }

  return (
    <div ref={rootRef} className={`relative inline-block min-w-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={switching}
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-gray-300 bg-white px-1.5 py-0.5 font-mono text-xs hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
        title="Switch branch"
      >
        <Icon path={ICONS.gitBranch} className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{shown || 'default branch'}</span>
        <Icon path={ICONS.chevron} className="h-3 w-3 shrink-0 rotate-90" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Switch branch"
          className="absolute left-0 z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-800 dark:bg-gray-900"
        >
          {loadError ? (
            <p className="px-3 py-1.5 text-xs text-red-600 dark:text-red-400">{loadError}</p>
          ) : branches === null ? (
            <p className="px-3 py-1.5 text-xs text-gray-500">Loading branches…</p>
          ) : branches.length === 0 ? (
            <p className="px-3 py-1.5 text-xs text-gray-500">No branches.</p>
          ) : (
            branches.map((option) => (
              <button
                key={option.name}
                type="button"
                role="option"
                aria-selected={option.name === shown}
                onClick={() => void pickAndClose(option.name)}
                className={`block w-full truncate px-3 py-1 text-left font-mono text-xs hover:bg-gray-100 dark:hover:bg-gray-800 ${
                  option.name === shown ? 'font-semibold' : ''
                }`}
              >
                {option.name}
              </button>
            ))
          )}
        </div>
      ) : null}
      {switchErrorCode ? (
        <Modal title="Can’t switch branches" onClose={clearSwitchError}>
          <SwitchBlockedNotice
            code={switchErrorCode}
            message={switchError}
            branchName={pendingBranch}
            discarding={discarding}
            onDiscard={() => void discardAndRetry()}
          />
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * The same branch list and POST, inside the shared Modal — for the
 * chat title bar's overflow menu on a narrow screen, where the inline
 * dropdown above has no room (see this file's header comment).
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
   * with it — unlike the inline dropdown, which updates itself in place.
   * The caller uses this to update whatever `branch` it passes to the
   * title bar's other, still-mounted label immediately, rather than
   * waiting on a full router.refresh() round-trip to reach it.
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
