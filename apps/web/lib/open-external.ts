/**
 * Hand an http(s) URL to the system default browser when running as an
 * installed iOS PWA.
 *
 * `target="_blank"` alone is not enough there: current iOS opens it in an
 * in-app browser sheet layered over the standalone app instead of leaving
 * for Safari. The `x-safari-` scheme prefix makes iOS route the navigation
 * out to the default browser. Returns true when the URL was handed off (the
 * caller should then suppress the default navigation); false means "not an
 * installed iOS PWA / not http(s)" and the normal target="_blank" behaviour
 * should proceed.
 */
export function isIosStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  // iPadOS reports a desktop Mac UA, so also accept touch-capable "MacIntel".
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
  if (!isIos) return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

export function openInSystemBrowser(href: string): boolean {
  if (!isIosStandalone()) return false;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  window.location.href = `x-safari-${url.href}`;
  return true;
}
