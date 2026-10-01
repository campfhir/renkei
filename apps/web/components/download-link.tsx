'use client';

import { useEffect, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/**
 * An <a> that downloads a file from this app — and doesn't strand the
 * person when the app is installed to the iOS home screen.
 *
 * A plain `<a href download>` in the standalone PWA hands the file to iOS's
 * download viewer ("Open in Preview", "More…"), which fills the whole app
 * with no back button and no Done. Opening the URL as a new window instead
 * just shows the file inside the app: escapable by an edge swipe, but still
 * with nothing on screen to close it.
 *
 * So on iOS standalone the file goes to the share sheet instead — "Save
 * Image", "Save to Files", AirDrop, and an ✕ that drops the person back
 * where they were. iOS only allows `navigator.share` straight from a tap,
 * not after awaiting a fetch, so the bytes are fetched ahead of the tap:
 * on mount when `prefetch` is set (a window opened to save one file), and
 * otherwise as the finger goes down. If the file isn't in hand by the
 * click, or this iOS can't share files, it falls back to the new window.
 *
 * `navigator.standalone` exists only on iOS/iPadOS WebKit, so none of this
 * touches desktop browsers, Safari tabs, or Android installs (whose
 * download manager already handles `download` fine).
 */
export function isIosStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  return Reflect.get(navigator, 'standalone') === true;
}

/** Files fetched ahead of a tap, by URL; null while the fetch is in flight or after it failed. */
const fetched = new Map<string, File | null>();
const KEEP = 8;

function canShareFiles(): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
}

function prefetchFile(href: string, filename: string | undefined): void {
  if (fetched.has(href) || !isIosStandalone() || !canShareFiles()) return;
  fetched.set(href, null);
  while (fetched.size > KEEP) {
    const oldest = fetched.keys().next().value;
    if (oldest === undefined) break;
    fetched.delete(oldest);
  }
  void fetch(href, { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const name =
        filename ||
        decodeURIComponent(new URL(href, location.href).pathname.split('/').pop() ?? 'download');
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare({ files: [file] })) fetched.set(href, file);
      else fetched.delete(href);
    })
    .catch(() => {
      fetched.delete(href);
    });
}

export default function DownloadLink({
  href,
  filename,
  prefetch = false,
  onClick,
  onPointerDown,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'download' | 'href'> & {
  href: string;
  /** The saved file's name; omit to keep the server's Content-Disposition name. */
  filename?: string;
  /** Fetch the file as soon as this renders on iOS standalone, so the first tap can share it. */
  prefetch?: boolean;
}) {
  useEffect(() => {
    if (prefetch) prefetchFile(href, filename);
  }, [prefetch, href, filename]);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || !isIosStandalone()) return;
    event.preventDefault();
    const file = fetched.get(href);
    if (file) {
      // Called synchronously in the tap: an await before it would cost the user gesture.
      navigator.share({ files: [file] }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        window.open(href, '_blank', 'noopener');
      });
      return;
    }
    window.open(href, '_blank', 'noopener');
  };
  return (
    <a
      href={href}
      download={filename ?? true}
      onClick={handleClick}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        prefetchFile(href, filename);
      }}
      {...props}
    />
  );
}
