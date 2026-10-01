'use client';

import type { AnchorHTMLAttributes, MouseEvent } from 'react';

/**
 * An <a> that downloads a file from this app — and doesn't strand the
 * person when the app is installed to the iOS home screen.
 *
 * A plain `<a href download>` navigates the standalone PWA's only webview
 * to the file. iOS answers with its file viewer ("Open in Preview",
 * "More…") filling the whole app, and since a standalone app has no Safari
 * chrome there is no back button, no Done, nothing to close it with — the
 * only way out is killing the app. Opening the same URL as a new window
 * instead makes iOS show it in its in-app browser sheet, which has a Done
 * button, and leaves the app where it was underneath.
 *
 * `navigator.standalone` exists only on iOS/iPadOS WebKit, so this changes
 * nothing for desktop browsers, Safari tabs, or Android installs (whose
 * download manager already handles `download` fine). The open happens
 * synchronously in the click so it still counts as a user gesture.
 */
export function isIosStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  return Reflect.get(navigator, 'standalone') === true;
}

export default function DownloadLink({
  href,
  filename,
  onClick,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'download' | 'href'> & {
  href: string;
  /** The saved file's name; omit to keep the server's Content-Disposition name. */
  filename?: string;
}) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || !isIosStandalone()) return;
    event.preventDefault();
    window.open(href, '_blank', 'noopener');
  };
  return <a href={href} download={filename ?? true} onClick={handleClick} {...props} />;
}
