'use client';

import { useEffect, useRef, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { clientLogger } from '@/lib/client-logger';
import { DOWNLOAD_PREFETCH_HEADER } from '@/lib/download-prefetch';

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
 * as soon as the link renders (once per URL, guarded by a ref) and again as the finger goes down. The link is
 * `aria-disabled` and ignores taps until the file is in hand, so a tap never
 * burns the gesture. If the fetch fails, or this iOS can't share files, it
 * falls back to the new window.
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

/** Whether this browser fetches ahead of a tap at all (iOS home-screen apps that can share files). */
function fetchesAhead(): boolean {
  return isIosStandalone() && canShareFiles();
}

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
      // Marked as a fetch ahead: a route that audits its download waits for the tap.
      const response = await fetch(href, {
        credentials: 'same-origin',
        headers: { [DOWNLOAD_PREFETCH_HEADER]: '1' },
      });
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
    } catch (error) {
      clientLogger.warn('download', 'could not fetch the file for the share sheet', error, {
        path: href.split('?')[0],
      });
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
  // Where nothing is fetched ahead there is nothing to wait for: 'ready'
  // from the first render, so the link never flashes a pending state.
  const waits = () => isIosStandalone() && canShareFiles();
  const [state, setState] = useState<'pending' | 'ready'>(() => (waits() ? 'pending' : 'ready'));
  useEffect(() => {
    let live = true;
    setState(waits() ? 'pending' : 'ready');
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
  prefetch: _prefetch,
  reportTaken,
  onClick,
  onPointerDown,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'download' | 'href'> & {
  href: string;
  /** The saved file's name; omit to keep the server's Content-Disposition name. */
  filename?: string;
  /** Ignored: every link fetches ahead now. Kept so existing callers still compile. */
  prefetch?: boolean;
  /**
   * For a download that is an audit event: when the file fetched ahead is
   * handed to the share sheet, POST the same address so the route records
   * the tap (lib/download-prefetch.ts). Anywhere else the download is the
   * browser's own GET, which the route audits itself.
   */
  reportTaken?: boolean;
}) {
  // The href whose fetch has settled (in hand, or failed and falling back to a
  // new window), and the href a fetch was last started for. The ref is what keeps
  // the effect below from fetching again on every render.
  const [settledHref, setSettledHref] = useState<string | null>(null);
  const requestedHref = useRef<string | null>(null);
  // Where the file is fetched ahead, the link is off until that has settled.
  const pending = fetchesAhead() && settledHref !== href;

  // No dependency list, on purpose: it runs after every render, but only the
  // first render for an href gets past the ref, so each file is fetched once.
  useEffect(() => {
    if (!fetchesAhead() || requestedHref.current === href) return;
    requestedHref.current = href;
    void prefetchFile(href, filename).then(() => setSettledHref(href));
  });

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (pending) {
      // Not ready: a tap now would fall back to a bare window, so it does nothing.
      event.preventDefault();
      return;
    }
    onClick?.(event);
    if (event.defaultPrevented || !isIosStandalone()) return;
    event.preventDefault();
    const file = fetched.get(href);
    if (file) {
      if (reportTaken) {
        void fetch(href, { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(
          () => undefined
        );
      }
      // Called synchronously in the tap: an await before it would cost the user gesture.
      navigator.share({ files: [file] }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (!(error instanceof DOMException && error.name === 'NotAllowedError')) {
          clientLogger.warn('download', 'share sheet failed', error);
        }
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
      aria-disabled={pending || undefined}
      data-pending={pending || undefined}
      onClick={handleClick}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        void prefetchFile(href, filename);
      }}
      {...props}
    />
  );
}
