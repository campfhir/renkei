/**
 * How the one Microsoft grant is presented as several product cards.
 *
 * Pure data, in its own module for the same reason microsoft-scopes.ts is:
 * it is imported by a client component, and keeping it out of the .tsx makes
 * it testable — the web suite does not transform JSX, so anything worth
 * asserting cannot live inside a component file.
 *
 * This is a PARTITION of MICROSOFT_SCOPE_GROUPS, not a second taxonomy. The
 * catalog's groups already fall along product lines; this only says which
 * card each belongs on. That the partition is total is load-bearing and not
 * self-enforcing — a group assigned to no product renders on no card, so the
 * capability silently becomes ungrantable while remaining in the ceiling and
 * in the authorize URL. microsoft-products.test.ts pins it.
 */

import { MICROSOFT_SCOPE_GROUPS, MICROSOFT_SCOPE_OPTIONS } from '@/lib/microsoft-scopes';
import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';

export interface MicrosoftProduct {
  /** Keys the extras map and the React list. */
  id: string;
  /**
   * The capability-registry key this product's tools are gated on. Outlook
   * and the directory share 'microsoft' — the connector config and the
   * registry treat mail and directory lookups as one connector.
   */
  capabilityKey: string;
  /**
   * The mark to show, which is NOT the capability key here: 'microsoft' as a
   * key covers both Outlook and the directory, and those are different
   * pictures. The company mark stands in for the directory because that is
   * what a tenant-wide people lookup actually is.
   */
  logo: string;
  title: string;
  summary: string;
  /** Scope groups shown on this card. */
  groupIds: string[];
}

export const MICROSOFT_PRODUCTS: MicrosoftProduct[] = [
  {
    id: 'outlook',
    capabilityKey: 'microsoft',
    logo: 'outlook',
    title: 'Outlook',
    summary: 'Mail, calendar and Microsoft To Do — read, searched, and ingested into knowledge.',
    groupIds: ['mail', 'calendar', 'tasks'],
  },
  {
    id: 'onedrive',
    capabilityKey: 'onedrive',
    logo: 'onedrive',
    title: 'OneDrive',
    summary: 'Your own files and folders, plus anything colleagues have shared with you.',
    groupIds: ['files'],
  },
  {
    id: 'sharepoint',
    capabilityKey: 'sharepoint',
    logo: 'sharepoint',
    title: 'SharePoint',
    summary: 'Sites, pages and document libraries — and the libraries kept indexed for search.',
    groupIds: ['sharepoint'],
  },
  {
    id: 'enterprise',
    capabilityKey: 'microsoft',
    // Not 'microsoft': the card containing this panel already shows that
    // mark, and a panel wearing its parent's logo reads as a duplicate rather
    // than a product. directory.svg is our own artwork — see its comment.
    logo: 'directory',
    title: 'Enterprise directory',
    summary:
      'Organization-wide lookups: colleagues, job titles, managers, groups and mailing lists.',
    groupIds: ['directory'],
  },
];

export function groupsOfProduct(product: MicrosoftProduct): ScopeGroup[] {
  return MICROSOFT_SCOPE_GROUPS.filter((group) => product.groupIds.includes(group.id));
}

export function optionsOfProduct(product: MicrosoftProduct): ScopeOption[] {
  return MICROSOFT_SCOPE_OPTIONS.filter((option) => product.groupIds.includes(option.group));
}
