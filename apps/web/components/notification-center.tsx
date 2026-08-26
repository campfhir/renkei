'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * The one place that asks "has anything happened?", shared by the nav
 * badge and the toast stack.
 *
 * ## Why polling, and not SSE
 *
 * A notification is written by `worker-agents`, in a different process from
 * whichever web replica holds this tab's connection. Streaming it would
 * mean Postgres LISTEN/NOTIFY or Redis, a long-lived connection per tab
 * through whatever proxy fronts the deployment, and reconnect handling —
 * a lot of moving parts for a payload that says "an agent sent an email".
 * The latency requirement is soft: a run takes minutes, so twenty seconds
 * is invisible.
 *
 * The cadence sits between the two existing pollers on purpose:
 * sync-progress uses 15s for an operation somebody is watching finish, and
 * auto-refresh uses 30s for a whole-page refresh. This is neither.
 *
 * ## The two rules that stop it being annoying
 *
 * The cursor advances by the SERVER's clock, never the browser's. A client
 * a few minutes fast would otherwise skip rows permanently, and a slow one
 * would show the same toast over and over.
 *
 * And the first poll after mount seeds the cursor from now, so signing in
 * on Monday does not fire three toasts about Tuesday. The backlog is the
 * badge's job; toasts are for what happens while you are looking.
 */

const POLL_MS = 20_000;
/** A hidden tab still updates, four times slower — the badge should be
 *  roughly right when somebody comes back, and 80s is cheap. */
const HIDDEN_FACTOR = 4;

export interface AppNotification {
  id: string;
  kind: string;
  category: string | null;
  connector: string | null;
  tool: string | null;
  headline: string;
  refUrl: string | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationState {
  /** Unread count for the nav badge. */
  unread: number;
  /** Arrivals since this tab started watching — what the toasts show. */
  arrivals: AppNotification[];
  dismiss: (id: string) => void;
  /** Called after the page marks things read, to resync the badge. */
  refresh: () => void;
}

const Context = createContext<NotificationState>({
  unread: 0,
  arrivals: [],
  dismiss: () => undefined,
  refresh: () => undefined,
});

export function useNotifications(): NotificationState {
  return useContext(Context);
}

export function NotificationCenter({
  tenantId,
  children,
}: {
  tenantId: string;
  children: ReactNode;
}) {
  const [unread, setUnread] = useState(0);
  const [arrivals, setArrivals] = useState<AppNotification[]>([]);
  // The cursor, always a server timestamp. In a ref because the polling
  // effect must not restart every time it moves.
  const since = useRef<string | null>(null);
  const seeded = useRef(false);

  const load = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      const url = new URL(`/api/tenant/${tenantId}/notifications`, window.location.origin);
      if (since.current) url.searchParams.set('since', since.current);
      const response = await fetch(url.toString());
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) return;
      const parsed: { notifications?: AppNotification[]; unread?: number; serverTime?: string } =
        body;

      setUnread(typeof parsed.unread === 'number' ? parsed.unread : 0);

      const fresh = Array.isArray(parsed.notifications) ? parsed.notifications : [];
      // First pass only establishes where "now" is. Anything already there
      // belongs to the badge and the page, not to the corner of the screen.
      if (seeded.current && fresh.length > 0) {
        setArrivals((current) => {
          const known = new Set(current.map((entry) => entry.id));
          const added = fresh.filter((entry) => !known.has(entry.id));
          return added.length > 0 ? [...added, ...current] : current;
        });
      }
      seeded.current = true;
      if (typeof parsed.serverTime === 'string') since.current = parsed.serverTime;
    } catch {
      // Offline, a redeploy mid-flight, a 500 — the next tick tries again.
      // A notification centre must never be the thing that breaks a page.
    }
  }, [tenantId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      void load().finally(() => {
        if (cancelled) return;
        const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
        timer = setTimeout(tick, hidden ? POLL_MS * HIDDEN_FACTOR : POLL_MS);
      });
    };
    tick();

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const dismiss = useCallback((id: string) => {
    setArrivals((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return (
    <Context.Provider value={{ unread, arrivals, dismiss, refresh }}>{children}</Context.Provider>
  );
}
