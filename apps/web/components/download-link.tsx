'use client';

import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

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

/** Files fetched ahead of a tap, by URL: a file is here only once it can be shared. */
const fetched = new Map<string, File>();
/** Fetches in progress, by URL, so a second ask waits on the first. */
const inFlight = new Map<string, Promise<boolean>>();
const KEEP = 8;

function canShareFiles(): boolean {
  return typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
}

/**
 * Fetches the file for the share sheet, and resolves whether it is in hand.
 * Only iOS home-screen apps that can share files fetch; anywhere else this
 * resolves false at once and the link keeps its own download.
 */
function prefetchFile(href: string, filename: string | undefined): Promise<boolean> {
  if (fetched.has(href)) return Promise.resolve(true);
  if (!isIosStandalone() || !canShareFiles()) return Promise.resolve(false);
  const running = inFlight.get(href);
  if (running) return running;
  const started = (async () => {
    try {
      const response = await fetch(href, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const name =
        filename ||
        decodeURIComponent(new URL(href, location.href).pathname.split('/').pop() ?? 'download');
      const file = new File([blob], name, { type: blob.type });
      if (!navigator.canShare({ files: [file] })) return false;
      fetched.set(href, file);
      while (fetched.size > KEEP) {
        const oldest = fetched.keys().next().value;
        if (oldest === undefined) break;
        fetched.delete(oldest);
      }
      return true;
    } catch {
      return false;
    } finally {
      inFlight.delete(href);
    }
  })();
  inFlight.set(href, started);
  return started;
}

/**
 * 'pending' while a download's file is fetched for the share sheet, then
 * 'ready'. Show the link only once it is 'ready', and its first tap opens the
 * share sheet with the file already in hand. Anywhere the file cannot be
 * shared, it is 'ready' straight away and the link downloads as usual.
 */
export function useDownloadReady(href: string, filename: string | undefined): 'pending' | 'ready' {
  const [state, setState] = useState<'pending' | 'ready'>('pending');
  useEffect(() => {
    let live = true;
    setState('pending');
    void prefetchFile(href, filename).then(() => {
      if (live) setState('ready');
    });
    return () => {
      live = false;
    };
  }, [href, filename]);
  return state;
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
