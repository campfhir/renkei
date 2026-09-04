'use client';

/**
 * Two columns on a wide screen, one on a narrow one: the sidebar lives in
 * the grid from `lg` up and becomes a drawer below it, opened from the
 * thread header. The breakpoint is the one collapsible-section.tsx uses
 * for the same decision, so the whole app flips together.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useMediaQuery } from '@/lib/use-media-query';
import type { ChatSidebarData } from '@/lib/chat/sidebar';
import ChatSidebar from './chat-sidebar';

interface ShellContextValue {
  openSidebar: () => void;
  isNarrow: boolean;
}

const ShellContext = createContext<ShellContextValue>({ openSidebar: () => {}, isNarrow: false });

export function useChatShell(): ShellContextValue {
  return useContext(ShellContext);
}

export default function ChatShell({
  slug,
  tenantId,
  subject,
  sidebar,
  children,
}: {
  slug: string;
  tenantId: string;
  subject: string;
  sidebar: ChatSidebarData;
  children: ReactNode;
}) {
  const isNarrow = useMediaQuery('(max-width: 1023.98px)');
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const drawerRef = useRef<HTMLElement>(null);

  // Navigating closes the drawer; a chat opened from it should show.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    drawerRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const openSidebar = useCallback(() => setOpen(true), []);

  const panel = (
    <ChatSidebar
      slug={slug}
      tenantId={tenantId}
      subject={subject}
      data={sidebar}
      currentPath={pathname}
    />
  );

  return (
    <ShellContext.Provider value={{ openSidebar, isNarrow }}>
      <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
        <aside className="hidden w-72 shrink-0 flex-col border-r border-gray-200 lg:flex dark:border-gray-800">
          {panel}
        </aside>
        {open ? (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/40 lg:hidden"
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            <aside
              ref={drawerRef}
              tabIndex={-1}
              aria-label="Chats"
              className="fixed inset-y-0 left-0 z-50 flex w-80 max-w-[85vw] flex-col bg-white shadow-xl outline-none lg:hidden dark:bg-gray-950"
            >
              {panel}
            </aside>
          </>
        ) : null}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</section>
      </div>
    </ShellContext.Provider>
  );
}
