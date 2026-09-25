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
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { Icon, ICONS } from '@/components/icons';

interface HostBranch {
  name: string;
  headSha: string;
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
  const router = useRouter();
  const base = `/api/tenant/${tenantId}/code/projects/${projectId}/branch`;
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<HostBranch[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Shown immediately on a successful switch, rather than waiting on the
  // server round-trip a router.refresh() triggers — the person just
  // watched it happen. Re-synced whenever the project's own idea of the
  // branch moves for some other reason (a new chat cloning fresh, say).
  const [shown, setShown] = useState(branch);
  useEffect(() => setShown(branch), [branch]);

  useEffect(() => {
    if (!open || branches !== null) return;
    void (async () => {
      const result = await getJson<{ branches: HostBranch[] }>(base);
      if (result.data) setBranches(result.data.branches);
      else setLoadError(result.error ?? 'Branches could not be read.');
    })();
  }, [open, branches, base]);

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

  const pick = async (name: string) => {
    if (name === shown || switching) return;
    setSwitching(true);
    setSwitchError(null);
    const result = await sendJsonFull<{ branch: string }>(base, 'POST', { branch: name });
    setSwitching(false);
    if (result.error) {
      setSwitchError(result.error);
      return;
    }
    setShown(result.data?.branch ?? name);
    setOpen(false);
    setBranches(null);
    router.refresh();
  };

  if (!canSwitch) {
    return (
      <span
        className={`inline-flex items-center gap-1 font-mono ${className}`}
        title={reason}
      >
        <Icon path={ICONS.gitBranch} className="h-3.5 w-3.5 shrink-0" />
        {shown || 'default branch'}
      </span>
    );
  }

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={switching}
        className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-1.5 py-0.5 font-mono text-xs hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:hover:bg-gray-800"
        title="Switch branch"
      >
        <Icon path={ICONS.gitBranch} className="h-3.5 w-3.5 shrink-0" />
        {shown || 'default branch'}
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
                onClick={() => void pick(option.name)}
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
      {switchError ? (
        <p role="alert" className="absolute top-full left-0 z-20 mt-1 w-64 text-xs text-red-600 dark:text-red-400">
          {switchError}
        </p>
      ) : null}
    </div>
  );
}
