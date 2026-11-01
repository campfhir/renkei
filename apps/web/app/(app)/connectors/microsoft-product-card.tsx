import type { ReactNode } from 'react';
import ConnectorIcon from '@/components/connector-icon';
import { ConnectorShell, ConnectorHeading } from './connector-shell';
import ScopePicker from '@/components/scope-picker';
import AuthorizedPermissions from '@/components/authorized-permissions';
import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
import { productPanel } from './microsoft-product-card.model';

/**
 * One Microsoft product, as a panel NESTED inside the Microsoft 365 card —
 * Outlook, OneDrive, SharePoint, Teams, OneNote or the directory.
 *
 * The nesting is the design. These are several products over ONE consent, and
 * an earlier pass had them as four sibling cards, each with its own Approve
 * button. That version worked but had to keep apologising for itself: every
 * card needed a sentence explaining that approving there would submit the
 * other three cards' selections too, because a re-consent REPLACES the grant
 * and a per-card URL would have silently revoked everything it omitted.
 *
 * Containment says the same thing without the sentence. The products are
 * visibly inside one connection, and the connect/disconnect/re-authorize
 * controls sit once at the bottom of the container that owns them. A panel
 * here holds only what is genuinely its own: its capabilities, and its own
 * controls (watched libraries, re-index, progress).
 *
 * A product whose options are all outside the org's ceiling renders NOTHING,
 * rather than an empty panel. A capability the org withheld is not this
 * user's business, and an empty panel invites a support ticket about a
 * feature they were never going to get. The counts, the badge and that
 * rule are microsoft-product-card.model.ts.
 */
export default function MicrosoftProductCard({
  capabilityKey,
  logo,
  title,
  summary,
  groups,
  options,
  ceiling,
  connected,
  authorized,
  checked,
  onToggle,
  children,
}: {
  /** Capability-registry key this product's tools are gated on. */
  capabilityKey: string;
  /** Logo filename stem — not the key: Outlook and the directory share one key. */
  logo: string;
  title: string;
  summary: string;
  /** This product's scope groups, for the picker's headings. */
  groups: ScopeGroup[];
  /** Only this product's options — the panel never sees the others. */
  options: ScopeOption[];
  /** The org's allowed scopes; the most a user can grant. */
  ceiling: string[];
  connected: boolean;
  /** Scopes recorded on the user's grant, or null if never recorded. */
  authorized: string[] | null;
  checked: ReadonlySet<string>;
  onToggle: (optionId: string, on: boolean) => void;
  /** Product-specific controls — watches, re-index, progress. */
  children?: ReactNode;
}) {
  const panel = productPanel({ options, ceiling, authorized, checked, connected });
  if (!panel) return null;
  const { pickable } = panel;

  // `panel.pending`: selections that have not been through Microsoft's
  // consent screen yet. Without the badge the checkboxes look like settings
  // that saved themselves — they are a draft until re-authorized, and the
  // badge is what tells someone WHICH product they changed when the button
  // is four panels away.
  return (
    <ConnectorShell nested>
      <div className="flex items-center justify-between gap-3">
        <ConnectorHeading nested>
          <ConnectorIcon capabilityKey={capabilityKey} logo={logo} label={title} size={18} />
          {title}
        </ConnectorHeading>
        <div className="flex items-center gap-2">
          {panel.pending && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              Not approved yet
            </span>
          )}
          {panel.badge &&
            (panel.badge.kind === 'on' ? (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                {panel.badge.text}
              </span>
            ) : (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {panel.badge.text}
              </span>
            ))}
        </div>
      </div>

      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{summary}</p>

      {!connected && (
        <details className="mt-2 rounded-md border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-950">
          <summary className="cursor-pointer text-xs font-medium">{panel.pickerSummary}</summary>
          <div className="mt-3">
            <ScopePicker
              groups={groups}
              options={pickable}
              checked={checked}
              onToggle={onToggle}
              available={ceiling}
              audience="user"
            />
          </div>
        </details>
      )}

      {connected && (
        <AuthorizedPermissions
          options={pickable}
          authorized={authorized}
          connectorLabel="Microsoft 365"
          // One product of a connector-wide grant: the other panels' scopes
          // are held but not explainable from here, and must not be counted
          // as sign-in permissions.
          scoped
          emptyLabel={`Nothing granted for ${title}. Tick what you want below, then re-authorize.`}
          changeHint={
            <>
              Adjust what {title} may do, then use <strong>Re-authorize</strong> at the bottom of
              this card — one approval covers every Microsoft product. You do not need to
              disconnect, and nothing already indexed is removed.
            </>
          }
        >
          <ScopePicker
            groups={groups}
            options={pickable}
            checked={checked}
            onToggle={onToggle}
            available={ceiling}
            audience="user"
          />
        </AuthorizedPermissions>
      )}

      {children}
    </ConnectorShell>
  );
}
