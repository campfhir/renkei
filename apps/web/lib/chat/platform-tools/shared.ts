/**
 * What the platform tools share: the name find_tools lists them under,
 * who counts as an operator, and how a path becomes a link the person can
 * follow.
 */

import { getPublicBaseUrl } from '@renkei/settings';
import { ROLE_OPERATOR } from '@/lib/access';
import type { LocalToolContext } from '../local-tools';

/** The "connector" the deferred platform tools are found under (tool-discovery.ts). */
export const PLATFORM_CONNECTOR = 'renkei';
/** How find_tools names that group. */
export const PLATFORM_LABEL = 'Renkei itself';

export function isOperator(context: Pick<LocalToolContext, 'roles'>): boolean {
  return (context.roles ?? []).includes(ROLE_OPERATOR);
}

/**
 * An absolute link to a path of the app. The app stands behind a proxy, so
 * the address is the one the person's own request arrived at
 * (LocalToolContext.origin, from lib/get-origin.ts), never this process's
 * host; a turn with no request behind it falls back to the deployment's
 * declared address, and with neither the path stands alone.
 */
export function linkTo(context: Pick<LocalToolContext, 'origin'>, path: string): string {
  const origin = (context.origin ?? getPublicBaseUrl() ?? '').replace(/\/+$/, '');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** `[label](link)`, the form a reply should hand a link over in. */
export function markdownLink(
  context: Pick<LocalToolContext, 'origin'>,
  label: string,
  path: string
): string {
  return `[${label.replace(/[[\]]/g, '')}](${linkTo(context, path)})`;
}
