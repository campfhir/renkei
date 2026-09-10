'use client';

import { useState } from 'react';
import { saveDisabledConnectors } from './availability-client';

/**
 * The off switches for one connector's capability keys, on its own page.
 * Same dial as the catalog list's checkboxes, same explanation: this hides
 * the tools org-wide and immediately, touching nobody's connection.
 */
export default function AvailabilityToggles({
  slug,
  initialDisabled,
  products,
}: {
  slug: string;
  initialDisabled: string[];
  products: Array<{ capabilityKey: string; label: string; toolPrefix: string }>;
}) {
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set(initialDisabled));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(capabilityKey: string, on: boolean) {
    const next = new Set(disabled);
    if (on) next.delete(capabilityKey);
    else next.add(capabilityKey);
    setDisabled(next);
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await saveDisabledConnectors(slug, next);
    if (failure) setError(failure);
    else setNotice('Saved. Tool lists refresh within a minute.');
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="font-semibold">Offered to everyone</h2>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        Switch off to stop these tools being offered to anyone in the organization, immediately.
        Nobody&rsquo;s connection is changed and nobody needs to reconnect — switching back on
        restores the tools as they were.
      </p>
      <ul className="mt-3 space-y-2">
        {products.map((product) => {
          const off = disabled.has(product.capabilityKey);
          return (
            <li key={product.capabilityKey}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!off}
                  disabled={busy}
                  onChange={(event) => void toggle(product.capabilityKey, event.target.checked)}
                />
                <span className={off ? 'text-gray-400' : ''}>
                  {product.label}
                  <span className="ml-2 font-mono text-[11px] text-gray-400">
                    {product.toolPrefix}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {notice && <p className="mt-3 text-sm text-green-700 dark:text-green-400">{notice}</p>}
      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </section>
  );
}
