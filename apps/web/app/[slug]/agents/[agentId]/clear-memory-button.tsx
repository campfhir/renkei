'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * "Start fresh": wipe this agent's memory (summary + entries). Two-click —
 * the first arms it — because the delete is immediate and unrecoverable,
 * and a confirm dialog would be heavier than the action deserves.
 */
export default function ClearMemoryButton({
  tenantId,
  agentId,
}: {
  tenantId: string;
  agentId: string;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const clear = async () => {
    setBusy(true);
    try {
      await fetch(`/api/tenant/${tenantId}/agents/${agentId}/memory`, { method: 'DELETE' });
      setArmed(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return armed ? (
    <span className="flex items-center gap-2 text-xs">
      <button
        type="button"
        disabled={busy}
        onClick={() => void clear()}
        className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        Really clear
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="text-gray-500 hover:underline"
      >
        Keep it
      </button>
    </span>
  ) : (
    <button
      type="button"
      onClick={() => setArmed(true)}
      className="text-xs text-red-600 hover:underline dark:text-red-400"
    >
      Clear memory
    </button>
  );
}
