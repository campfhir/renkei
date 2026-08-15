'use client';

/**
 * What a connected user granted, and how to change it — on the connected card.
 *
 * Consent you cannot review later is a weak kind of consent. Before this, the
 * permission list existed only on the connect card and vanished the moment you
 * connected: the single moment you could see what Renkei may do with your
 * mailbox was the moment before you decided, and never again.
 *
 * Changing permissions goes through the provider's approval screen again —
 * NOT through disconnect. That distinction is the whole reason this carries
 * the controls rather than a sentence of instructions: disconnecting is a
 * data-retention event (for Microsoft it purges every knowledge chunk indexed
 * from the mailbox), so "disconnect and reconnect to change a checkbox" asks
 * someone to delete their index to tick a box. Re-authorising upserts the same
 * grant row and re-stamps its scopes, leaving indexed content alone.
 */

import type { ReactNode } from 'react';
import { optionWithin, type ScopeOption } from '@/lib/scope-catalog';

export default function AuthorizedPermissions({
  options,
  authorized,
  connectorLabel,
  scoped = false,
  emptyLabel,
  changeHint,
  children,
}: {
  /** The catalog this card covers — the whole connector, or one product of it. */
  options: ScopeOption[];
  /** Scopes recorded on the user's grant. */
  authorized: readonly string[] | null;
  /** Name used in the instructions, e.g. "Microsoft 365". */
  connectorLabel: string;
  /**
   * True when `options` is only PART of the grant's catalog — one product
   * card over a connector-wide grant, as Microsoft's four cards are.
   *
   * It suppresses the unaccounted-scope count, which is otherwise actively
   * wrong here: that count assumes anything held but unexplained is a
   * sign-in scope, which holds only when `options` can explain everything
   * the grant carries. On a SharePoint card it would count the user's mail
   * and calendar scopes as "sign-in permissions used to identify you" —
   * confidently, and in the one place a person goes to audit what they gave
   * away.
   */
  scoped?: boolean;
  /** Replaces the "sign-in only" line when nothing here was granted. */
  emptyLabel?: string;
  /**
   * Replaces the instruction above the picker. Needed when the approve
   * control is NOT inside this block — Microsoft's product panels share one
   * button at the foot of their container, so the default "approve again",
   * with no button in view, would send the reader looking for one.
   */
  changeHint?: ReactNode;
  /** The picker and re-approve control, rendered under the divider. */
  children?: ReactNode;
}) {
  const held = new Set(authorized ?? []);
  // An option counts as granted only when EVERY scope it needs is present —
  // the same rule the picker uses against the ceiling, so the two agree.
  const granted = options.filter((option) => optionWithin(option, held));

  // Scopes on the grant that no catalog option accounts for: sign-in scopes,
  // or a capability granted before the catalog changed. Counted rather than
  // listed, since the raw strings mean nothing to the reader.
  const accountedFor = new Set(granted.flatMap((option) => option.scopes));
  const signIn = scoped ? 0 : [...held].filter((scope) => !accountedFor.has(scope)).length;

  return (
    <details className="mt-3 rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <summary className="cursor-pointer text-sm font-medium">
        What you allowed Renkei to do
        {granted.length > 0 && (
          <span className="ml-2 font-normal text-gray-500">
            {granted.length} {granted.length === 1 ? 'permission' : 'permissions'}
          </span>
        )}
      </summary>

      {held.size === 0 ? (
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
          This connection was made before Renkei recorded permissions, so the exact list is not
          stored. Approving again below will record it.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {granted.length === 0 && (
            <li className="text-sm text-gray-600 dark:text-gray-400">
              {emptyLabel ?? 'Sign-in only — no access to your data was granted.'}
            </li>
          )}
          {granted.map((option) => (
            <li key={option.id} className="text-sm">
              <span className="font-medium">{option.label}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                {option.userHint ?? option.hint}
              </span>
            </li>
          ))}
        </ul>
      )}

      {signIn > 0 && (
        <p className="mt-3 text-xs text-gray-500">
          Plus {signIn} sign-in {signIn === 1 ? 'permission' : 'permissions'} used to identify you.
        </p>
      )}

      {children && (
        <div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-800">
          <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
            {changeHint ?? (
              <>
                To change these, adjust the list and approve again — {connectorLabel} will ask you
                to confirm, exactly as it did the first time. You do not need to disconnect, and
                nothing already indexed is removed.
              </>
            )}
          </p>
          {children}
        </div>
      )}
    </details>
  );
}
