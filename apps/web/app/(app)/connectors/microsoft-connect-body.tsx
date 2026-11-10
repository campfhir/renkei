'use client';

/**
 * Everything about the Microsoft 365 card that genuinely needs live state:
 * the scope selection lifted across every product panel (see
 * microsoft-connector.tsx's doc comment on why it is ONE selection, not one
 * per panel), and the connect/re-authorize/disconnect controls that read it.
 *
 * Split out of microsoft-connector.tsx so that file can be a server
 * component for its header and description — the parts that only ever
 * depend on server-known `connected`/`displayName`, not on anything a click
 * changes. What the card decides is microsoft-connect-body.model.ts.
 */

import { useReducer, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { recordOrNull } from '@renkei/guards';
import { groupsOfProduct, optionsOfProduct } from '@/lib/microsoft-products';
import WatchManager from './watch-manager';
import OutlookIndexingPrefs from './outlook-indexing-prefs';
import MicrosoftProductCard from './microsoft-product-card';
import { useCoachAnchor } from '@/components/coach-marks/anchor';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  authorizeUrl,
  disconnectRefusal,
  initMicrosoftCard,
  microsoftCardReducer,
  offersSharePointWatches,
  reauthorize,
  selectionSummary,
  shownProducts,
} from './microsoft-connect-body.model';

export default function MicrosoftConnectBody({
  connected,
  ceiling,
  priorScopes,
  shownKeys,
}: {
  connected: boolean;
  /** The org's allowed scopes — the most a user can grant. */
  ceiling: string[];
  /** Scopes on the user's previous grant, seeding the picker on reconnect. */
  priorScopes: string[] | null;
  /**
   * Which products' panels to show, by capability key — the ones this
   * person added or connected. The consent is still one consent: a hidden
   * panel's scopes are simply not offered, the same as unticking them.
   */
  shownKeys: string[];
}) {
  const products = shownProducts(shownKeys);
  const router = useRouter();
  const context = { connected, ceiling, priorScopes };
  const [state, dispatch] = useReducer(microsoftCardReducer, context, initMicrosoftCard);
  const href = authorizeUrl(state);
  const control = reauthorize(state, context);

  function toggleOption(optionId: string, on: boolean) {
    dispatch({ type: 'toggled', optionId, on });
  }

  async function disconnect() {
    dispatch({ type: 'disconnectSent' });
    try {
      const response = await fetch(`/api/microsoft/grant`, { method: 'DELETE' });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const notice = disconnectRefusal(recordOrNull(data)?.error);
        reportFetchFailure('DELETE', '/api/microsoft/grant', response.status, notice);
        dispatch({ type: 'disconnectFailed', notice });
        return;
      }
      dispatch({ type: 'disconnected' });
      router.refresh();
    } catch (error) {
      reportFetchFailure('DELETE', '/api/microsoft/grant', 0, 'Could not reach the server', error);
      dispatch({ type: 'disconnectFailed', notice: 'Could not reach the server' });
    }
  }

  /** Product-specific controls, keyed by product id. */
  const extras: Record<string, ReactNode> = {
    // Nothing in Outlook is indexed (mail, calendar and To Do are personal),
    // so there is no progress to show and nothing to re-index: the one
    // control is the trigger-feed opt-in.
    outlook: connected ? <OutlookIndexingPrefs /> : null,

    // Gated on the grant actually carrying Sites.Read.All: without it,
    // listing sites, resolving a library and the background sweep all fail,
    // and offering the picker anyway would hand the user a form that can only
    // end in a 403. Absent priorScopes means a grant from before scopes were
    // recorded — show it, and let the picker's own error do the explaining,
    // rather than hiding the feature from everyone on an old grant.
    sharepoint: offersSharePointWatches(context) ? <WatchManager provider="sharepoint" /> : null,

    // Said plainly because the absence is otherwise indistinguishable from a
    // bug: the tools reach these files fine, so a user reasonably expects
    // search_knowledge to find them too.
    onedrive: connected ? (
      <p className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-500">
        Files here are reachable through the OneDrive tools on request. They are not indexed into
        knowledge search — that is available for SharePoint libraries only.
      </p>
    ) : null,

    // Same sentence for the two conversational products: nothing of theirs
    // is indexed, and saying so heads off the "why can't search find my
    // chat" ticket.
    teams: connected ? (
      <p className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-500">
        Chats and channels are read live as you, on request. Nothing from Teams is indexed into
        knowledge search, and messages are only ever sent from a preview card you approve.
      </p>
    ) : null,
    onenote: connected ? (
      <p className="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-500">
        Pages are read live as you, on request, and written only from a preview card you approve.
        Nothing from OneNote is indexed into knowledge search.
      </p>
    ) : null,
  };

  const productsAnchor = useCoachAnchor('microsoft-products');
  const connectAnchor = useCoachAnchor('microsoft-connect');

  return (
    <>
      <div {...productsAnchor} className="mt-3 space-y-3">
        {products.map((product) => (
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
            checked={state.selected}
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
        {state.notice && (
          <p className="mb-3 rounded-md bg-gray-100 p-2 text-sm dark:bg-gray-900">{state.notice}</p>
        )}

        {!connected && (
          <>
            <a
              {...connectAnchor}
              href={href}
              className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Connect Microsoft 365
            </a>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {selectionSummary(state, context)}
            </p>
          </>
        )}

        {connected && state.confirming && (
          <div className="rounded-lg border border-red-300 p-3 dark:border-red-800">
            <p className="mb-3 text-sm">
              Disconnect your Microsoft 365 account? Every product above stops working — Outlook,
              OneDrive, SharePoint and directory lookups alike — until you reconnect.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => void disconnect()}
                disabled={state.busy}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {state.busy ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button
                onClick={() => dispatch({ type: 'disconnectKept' })}
                disabled={state.busy}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-700"
              >
                Keep it
              </button>
            </div>
          </div>
        )}

        {connected && !state.confirming && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <a
                {...connectAnchor}
                href={href}
                className={`inline-block rounded-lg px-4 py-2 text-sm font-medium ${
                  control.emphasized
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'border border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900'
                }`}
              >
                {control.label}
              </a>
              <button
                onClick={() => dispatch({ type: 'disconnectAsked' })}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
              >
                Disconnect
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{control.hint}</p>
          </>
        )}
      </div>
    </>
  );
}
