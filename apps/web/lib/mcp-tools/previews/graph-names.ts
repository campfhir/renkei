/**
 * Shared wording for the Microsoft 365 cards (documents, OneNote, Outlook,
 * Teams): how a call's site or group reads to a person when the lookup could
 * or could not name it. Never an id.
 */

import type { Names } from './card';
import { named, text } from './card';

/**
 * A site, the way a person would say it: its looked-up name, else the last
 * piece of a pasted site address, else '' (an id says nothing to anyone).
 */
export function siteLabel(names: Names, site: unknown): string {
  const found = named(names, 'site', site);
  if (found) return found;
  const value = text(site);
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    const sites = segments.indexOf('sites');
    const last = sites === -1 ? '' : (segments[sites + 1] ?? '');
    return decodeURIComponent(last) || url.hostname;
  } catch {
    return '';
  }
}
