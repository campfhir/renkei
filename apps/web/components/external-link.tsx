import type { AnchorHTMLAttributes } from 'react';

/**
 * An <a> to somewhere off this app, opened in its own tab rather than
 * navigating in place.
 *
 * The iOS home-screen install runs with display: 'standalone'
 * (lib/app-manifest.ts) — a standalone PWA has no second tab to open, so an
 * in-place link to another origin renders trapped inside the PWA's own
 * webview, with no Safari chrome and no way back. target="_blank" is what
 * makes iOS hand the navigation off to Safari instead of swallowing it;
 * rel="noopener noreferrer" is the paired safety on any target="_blank".
 * This was a copy-pasted pair on 20+ links before this component existed,
 * with a couple missing `noopener` — one place to get it right.
 */
export default function ExternalLink({
  href,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'target' | 'rel'> & { href: string }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" {...props} />;
}
