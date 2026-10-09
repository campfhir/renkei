import { getPublicBaseUrl } from '@renkei/settings';

/**
 * Where the deployment lives, or null when it has no PUBLIC_BASE_URL.
 * Shared by cardsFeedUrl and registrationUrl.
 */
function appUrl(): string | null {
  return getPublicBaseUrl() || null;
}

/**
 * Where the card feed lives, for confirmation links in WebEx messages. Null
 * when the deployment does not know its address — the caller words its
 * confirmation without a link.
 */
export async function cardsFeedUrl(): Promise<string | null> {
  // The app root IS the feed — `/home` still redirects there, but linking
  // through a redirect for every card confirmation is a wasted hop.
  return appUrl();
}

/**
 * Where someone with no Renkei account yet should go to sign in — the
 * deployment's base URL. Visiting it while signed out is what creates the
 * identities row (apps/web/lib/identity.ts) the ambient handler checks for
 * on the next message. Null on the same condition as cardsFeedUrl.
 */
export async function registrationUrl(): Promise<string | null> {
  return appUrl();
}
