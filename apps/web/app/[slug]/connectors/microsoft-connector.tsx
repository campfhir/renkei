'use client';

import ConnectorIcon from '@/components/connector-icon';
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { MICROSOFT_SCOPE_OPTIONS } from '@/lib/microsoft-scopes';
import { MICROSOFT_PRODUCTS, groupsOfProduct, optionsOfProduct } from '@/lib/microsoft-products';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';
import SyncProgress from './sync-progress';
import WatchManager from './watch-manager';
import MicrosoftProductCard from './microsoft-product-card';

/**
 * The user's own Microsoft 365 connection: one card, containing a panel per
 * product — Outlook, OneDrive, SharePoint, the directory — and one set of
 * connect / disconnect / re-authorize controls at its foot.
 *
 * The shape follows the grant. Microsoft issues a SINGLE consent covering
 * every product, and a re-consent REPLACES it rather than adding to it. So
 * there is exactly one authorize URL, built from the union of every panel's
 * selections. An earlier pass gave each product its own card and its own
 * Approve button, which was a trap dressed as symmetry: a per-card URL would
 * carry only that product's scopes, and approving a SharePoint tweak would
 * silently revoke mail, calendar and files — no error, no warning, just tools
 * quietly missing from the list afterwards. Every card had to carry a
 * paragraph explaining that its button did something other than what its
 * position implied.
 *
 * Containing the panels states it structurally instead. The products are
 * visibly inside one connection; the control that acts on the whole
 * connection sits at the bottom of the thing it acts on, once.
 *
 * This component therefore owns what cannot be split — identity, connection
 * state, and the scope selection — and each panel owns only its own
 * capabilities and controls.
 */

export default function MicrosoftConnector({
  tenantId,
  connected,
  displayName,
  ceiling,
  priorScopes,
}: {
  tenantId: string;
  connected: boolean;
  displayName: string | null;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexNotice, setReindexNotice] = useState<string | null>(null);
  // Only catalog options count as choices; required scopes (openid, profile,
  // email, offline_access, User.Read) ride along server-side and are not
  // offered here.
  const ceilingSet = new Set(ceiling);
  const pickable = MICROSOFT_SCOPE_OPTIONS.filter((option) => optionWithin(option, ceilingSet));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const prior = priorScopes === null ? null : new Set(priorScopes);
    const seed = prior
      ? pickable.filter((option) => optionWithin(option, prior)).map((option) => option.id)
      : [];
    return new Set(seed.length > 0 ? seed : pickable.map((option) => option.id));
  });

  function toggleOption(optionId: string, on: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (on) next.add(optionId);
      else next.delete(optionId);
      return next;
    });
  }

  // The union, always — see the note on lifting selection state above.
  const authorizeUrl = `/api/microsoft/${tenantId}/authorize?scopes=${encodeURIComponent(
    scopesOfOptions(MICROSOFT_SCOPE_OPTIONS, selectedIds).join(' ')
  )}`;

  /**
   * Whether any panel's selection has diverged from what Microsoft actually
   * holds. Computed across ALL products, because the button is one button:
   * a change made in SharePoint has to light up a control four panels below
   * it, or the checkbox looks like a setting that saved itself.
   *
   * A null priorScopes is a grant from before scopes were recorded — there is
   * nothing to diff against, so nothing is claimed to have changed.
   */
  const held = new Set(priorScopes ?? []);
  const grantedOptions = pickable.filter((option) => optionWithin(option, held));
  const selectedOptions = pickable.filter((option) => selectedIds.has(option.id));
  const pending =
    connected &&
    priorScopes !== null &&
    (selectedOptions.length !== grantedOptions.length ||
      selectedOptions.some((option) => !grantedOptions.includes(option)));

  async function disconnect() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/microsoft/${tenantId}/grant`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.error ?? 'Could not disconnect');
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch {
      setNotice('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  async function reindex() {
    setReindexing(true);
    setReindexNotice(null);
    try {
      const response = await fetch(`/api/microsoft/${tenantId}/reindex`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      setReindexNotice(
        response.ok
          ? 'Re-indexing started — everything will be re-fetched and re-cleaned in the background.'
          : (data.error ?? 'Could not start re-indexing')
      );
    } catch {
      setReindexNotice('Could not reach the server');
    } finally {
      setReindexing(false);
    }
  }

  /** Product-specific controls, keyed by product id. */
  const extras: Record<string, ReactNode> = {
    outlook: connected ? (
      <>
        <div className="mt-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => void reindex()}
              disabled={reindexing}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900"
            >
              {reindexing ? 'Starting…' : 'Re-index'}
            </button>
            {reindexNotice && (
              <span className="text-sm text-gray-600 dark:text-gray-400">{reindexNotice}</span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Replaces what Renkei has indexed: it clears the existing mail, calendar and task
            entries, then re-fetches everything from Outlook and re-runs it through the current
            cleaning rules. Nothing in Outlook itself is touched. Useful after changing classifier
            rules or teaching a new sender template on Mail review.
          </p>
        </div>
        <SyncProgress tenantId={tenantId} connector="microsoft" />
      </>
    ) : null,

    // Gated on the grant actually carrying Sites.Read.All: without it,
    // listing sites, resolving a library and the background sweep all fail,
    // and offering the picker anyway would hand the user a form that can only
    // end in a 403. Absent priorScopes means a grant from before scopes were
    // recorded — show it, and let the picker's own error do the explaining,
    // rather than hiding the feature from everyone on an old grant.
    sharepoint:
      connected && (priorScopes === null || priorScopes.includes('Sites.Read.All')) ? (
        <WatchManager tenantId={tenantId} provider="sharepoint" />
      ) : null,

    // Said plainly because the absence is otherwise indistinguishable from a
    // bug: the tools reach these files fine, so a user reasonably expects
    // search_knowledge to find them too.
    onedrive: connected ? (
      <p className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-500">
        Files here are reachable through the OneDrive tools on request. They are not indexed into
        knowledge search — that is available for SharePoint libraries only.
      </p>
    ) : null,
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <ConnectorIcon capabilityKey="microsoft" label="Microsoft 365" size={20} />
          Microsoft 365 (your account)
        </h2>
        {connected ? (
          <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
            Connected
          </span>
        ) : (
          <span className="rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300">
            Not connected
          </span>
        )}
      </div>

      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
        {connected && displayName ? (
          <>
            Connected as <strong>{displayName}</strong>. One connection covers every product below.
          </>
        ) : (
          'Grant Renkei access to your own Microsoft 365. Choose what each product may do, then connect once — Microsoft asks for all of it in a single approval.'
        )}
      </p>

      <div className="mt-3 space-y-3">
        {MICROSOFT_PRODUCTS.map((product) => (
          <MicrosoftProductCard
            key={product.id}
            capabilityKey={product.capabilityKey}
            logo={product.logo}
            title={product.title}
            summary={product.summary}
            groups={groupsOfProduct(product)}
            options={optionsOfProduct(product)}
            ceiling={ceiling}
            connected={connected}
            authorized={priorScopes}
            checked={selectedIds}
            onToggle={toggleOption}
          >
            {extras[product.id]}
          </MicrosoftProductCard>
        ))}
      </div>

      {/*
        The connection's own controls, at the foot of the connection they act
        on. One consent, so one set — and the divider is what makes them read
        as belonging to the card rather than to the last product panel above
        them.
      */}
      <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-800">
        {notice && (
          <p className="mb-3 rounded-md bg-gray-100 p-2 text-sm dark:bg-gray-900">{notice}</p>
        )}

        {!connected && (
          <>
            <a
              href={authorizeUrl}
              className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Connect Microsoft 365
            </a>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {selectedIds.size} of {pickable.length} capabilities selected across all products.
            </p>
          </>
        )}

        {connected && confirming && (
          <div className="rounded-lg border border-red-300 p-3 dark:border-red-800">
            <p className="mb-3 text-sm">
              Disconnect your Microsoft 365 account? Every product above stops working — Outlook,
              OneDrive, SharePoint and directory lookups alike — until you reconnect.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => void disconnect()}
                disabled={busy}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
              >
                Keep it
              </button>
            </div>
          </div>
        )}

        {connected && !confirming && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={authorizeUrl}
                className={`inline-block rounded-lg px-4 py-2 text-sm font-medium ${
                  pending
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'border border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900'
                }`}
              >
                {pending ? 'Approve changes' : 'Re-authorize'}
              </a>
              <button
                onClick={() => setConfirming(true)}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
              >
                Disconnect
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {pending
                ? 'You changed what a product may do. Microsoft still has the previous permissions until you approve.'
                : 'Re-authorizing sends your current selections as one consent. Nothing already indexed is removed.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
