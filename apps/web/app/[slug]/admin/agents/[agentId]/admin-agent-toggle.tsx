'use client';

/**
 * The admin detail page's on/off switch — bidirectional, unlike the
 * oversight table's disable-only button: an admin here can put an agent
 * back on too (the `enable` route, mirroring `disable`), not just take it
 * off. Both routes audit the change either way.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendJson } from '@/lib/fetch-json';

export default function AdminAgentToggle({
  slug,
  agentId,
  enabled,
}: {
  slug: string;
  agentId: string;
  enabled: boolean;
}): React.ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (
      enabled &&
      !window.confirm('Turn this agent off? Its owner (or you) can turn it back on.')
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const failed = await sendJson(
      `/api/admin/${slug}/agents/${agentId}/${enabled ? 'disable' : 'enable'}`,
      'POST'
    );
    setBusy(false);
    if (failed) setError(failed);
    else router.refresh();
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={enabled ? 'Turn agent off' : 'Turn agent on'}
        title={enabled ? 'On — click to turn off' : 'Off — click to turn on'}
        disabled={busy}
        onClick={toggle}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-700'
        }`}
      >
        <span
          className={`inline-block transform rounded-full bg-white shadow transition-transform ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
          style={{ height: '1.125rem', width: '1.125rem' }}
        />
      </button>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
