'use client';

/**
 * The two controls the catalog adds to the connectors page: the button that
 * opens it, and the "remove" affordance under a card that was added but
 * never connected.
 *
 * Remove is offered only where nothing is connected. A connected card
 * already has Disconnect, and hiding a card over a live grant is precisely
 * the "looks off, isn't" trap the access-control design warns about — the
 * page must never show less than the MCP endpoint can do.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import AddConnectorModal, { type CatalogItem } from './add-connector-modal';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { reportFetchFailure } from '@/lib/fetch-json';

export function AddConnectorButton({
  items,
  emphasis = false,
}: {
  items: CatalogItem[];
  /** The empty-state rendering: a primary button rather than a quiet one. */
  emphasis?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState('');
  const addAnchor = useCoachAnchor('connectors-add');
  // A top-bar result for a connector that is not on the page: its card
  // is not there to scroll to, so the catalog opens, searched for it.
  useEffect(() => {
    const find = new URLSearchParams(window.location.search).get('find');
    const card = window.location.hash.slice(1);
    if (!find || !card || document.getElementById(card)) return;
    setInitialQuery(find);
    setOpen(true);
  }, []);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        {...addAnchor}
        className={
          emphasis
            ? 'inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700'
            : 'inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900'
        }
      >
        <Icon path={ICONS.plus} />
        Add connector
      </button>
      {open && (
        <AddConnectorModal
          items={items}
          initialQuery={initialQuery}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Under a card: which of its products are on the page without a
 * connection, each with a remove link. A suite card lists several; a
 * single-product card lists one.
 */
export function RemovableProducts({
  products,
}: {
  products: Array<{ capabilityKey: string; label: string }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (products.length === 0) return null;

  async function remove(capabilityKey: string) {
    setBusy(capabilityKey);
    setError(null);
    try {
      const response = await fetch(`/api/connector-selections`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector: capabilityKey }),
      });
      if (!response.ok) {
        reportFetchFailure(
          'DELETE',
          '/api/connector-selections',
          response.status,
          'Could not remove'
        );
        setError('Could not remove');
        return;
      }
      router.refresh();
    } catch (error) {
      reportFetchFailure(
        'DELETE',
        '/api/connector-selections',
        0,
        'Could not reach the server',
        error
      );
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
      {products.map((product, index) => (
        <span key={product.capabilityKey}>
          {index > 0 && ' · '}
          <button
            type="button"
            onClick={() => void remove(product.capabilityKey)}
            disabled={busy !== null}
            className="underline decoration-dotted underline-offset-2 hover:text-gray-800 disabled:opacity-50 dark:hover:text-gray-200"
          >
            {busy === product.capabilityKey ? 'Removing…' : `Remove ${product.label}`}
          </button>
        </span>
      ))}
      {error && <span className="ml-2 text-red-700 dark:text-red-400">{error}</span>}
    </p>
  );
}
