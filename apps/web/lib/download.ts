/**
 * Starts a download of a URL of this app from a click that is not on a
 * link — a menu item, say. A hidden anchor with `download` is what a
 * browser hands to its download manager without leaving the page; the
 * cookie goes with it, so the route sees the person as usual. (A link
 * that is a link should be a DownloadLink, components/download-link.tsx,
 * which also handles the iOS home-screen app.)
 */
export function startDownload(href: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = '';
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
