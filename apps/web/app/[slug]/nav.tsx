'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import RenkeiMark from '@/components/renkei-mark';
import { Icon, ICONS } from '@/components/icons';
import { useNotifications } from '@/components/notification-center';
import { useMediaQuery } from '@/lib/use-media-query';
import type { ChatSidebarData } from '@/lib/chat/sidebar';
import { ChatList } from './chat/_components/chat-nav';

interface NavProps {
  slug: string;
  tenantId: string;
  /** Display name from the identity spine, falling back to email/subject. */
  userName: string | null;
  userEmail: string | null;
  isOperator: boolean;
  signInHref: string;
  /** The person's chats, for the Chat section's list; null when signed out. */
  chats: ChatSidebarData | null;
  /** Version + commit hash for display in sidebar. */
  version: string;
  children: ReactNode;
}

/** The same breakpoint collapsible-section.tsx flips on, so the app moves together. */
const NARROW = '(max-width: 1023.98px)';
const PINNED_KEY = 'renkei:nav-pinned';

/** "Ada Lovelace" → "AL"; single word or an email → its first letter. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

interface NavItem {
  href: string;
  label: string;
  /** Paths under `href` that belong to a sibling item, not this one. */
  except?: string[];
  /** Only the exact path counts — Home, whose prefix is every page. */
  exact?: boolean;
  /** A small "+" link at the row's right edge — New chat, beside Chat. */
  plus?: { href: string; label: string };
}

interface NavGroup {
  label: string;
  items: NavItem[];
  /** Rendered under the items — the Chat section's recent chats. */
  extra?: ReactNode;
}

/**
 * The app-wide navigation and the frame around every page: a top bar with
 * the hamburger, org name and the user; the menu itself,
 * with the sections stacked. On a wide screen the menu is a column that
 * stays open beside the page (the hamburger tucks it away, and the choice
 * is remembered in this browser); below `lg` it is the drawer that slides
 * in from the left edge. The account menu behind the avatar holds the
 * person's own settings and records, and — for operators only — the way
 * to the Organization page; the pages behind it still guard themselves,
 * the nav just does not advertise doors the user cannot open.
 */
export default function AppNav({
  slug,
  tenantId,
  userName,
  userEmail,
  isOperator,
  signInHref,
  chats,
  version,
  children,
}: NavProps) {
  const isNarrow = useMediaQuery(NARROW);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  // Reads the layout's poller. Outside a NotificationCenter — the
  // signed-out shell — the context default is 0, so the badge simply
  // never appears rather than the nav failing to render.
  const { unread } = useNotifications();
  const [signingOut, setSigningOut] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const drawerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The avatar menu closes on navigation, Escape, and any click outside it.
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  // Whether the column stays open on a wide screen is this browser's
  // choice; read after mount, as the server cannot know it.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(PINNED_KEY) === '0') setPinned(false);
    } catch {
      // No storage: the column simply starts open every visit.
    }
  }, []);
  const togglePinned = () => {
    setPinned((value) => {
      try {
        window.localStorage.setItem(PINNED_KEY, value ? '0' : '1');
      } catch {
        // Not remembered, still toggled.
      }
      return !value;
    });
  };

  // The drawer closes on navigation, on Escape, and traps initial focus so a
  // keyboard user is not left tabbing through content hidden behind it.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    drawerRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The column carries the places a person works; what they configure
  // for themselves is behind their avatar, and what they run for the
  // organization is the Organization page.
  const groups: NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { href: `/${slug}`, label: 'Home', exact: true },
        { href: `/${slug}/agents`, label: 'Agents' },
        { href: `/${slug}/knowledge`, label: 'Knowledge' },
        { href: `/${slug}/files`, label: 'Files' },
      ],
    },
    {
      label: 'Chat',
      items: [
        {
          href: `/${slug}/chat`,
          label: 'Chat',
          except: [`/${slug}/chat/projects`, `/${slug}/chat/prompts`],
          plus: { href: `/${slug}/chat/new`, label: 'New chat' },
        },
        { href: `/${slug}/chat/projects`, label: 'Projects' },
        { href: `/${slug}/chat/prompts`, label: 'Prompt libraries' },
      ],
      extra: chats ? <ChatList slug={slug} tenantId={tenantId} data={chats} /> : null,
    },
  ];

  // The account menu: the person's own settings and records, then the
  // organization console for operators. Groups are separated by rules.
  const accountGroups: NavItem[][] = [
    [
      { href: `/${slug}/notifications`, label: 'Notifications' },
      { href: `/${slug}/preferences`, label: 'Preferences' },
      { href: `/${slug}/connectors`, label: 'Connectors' },
    ],
    [
      { href: `/${slug}/batch-jobs`, label: 'Batch jobs' },
      { href: `/${slug}/usage`, label: 'Tools' },
      { href: `/${slug}/utilization`, label: 'My usage' },
      // Mail review is deliberately unlinked, not removed: it is the only
      // place a person can correct how their own mail was classified, and
      // there is no admin equivalent by design. The route still works for
      // anyone who has it bookmarked or is sent there.
      { href: `/${slug}/logs`, label: 'Activity' },
    ],
    ...(isOperator ? [[{ href: `/${slug}/admin`, label: 'Organization' }]] : []),
    [{ href: `/${slug}/about`, label: 'About' }],
  ];

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      });
    } finally {
      router.push('/');
      router.refresh();
    }
  }

  const initials = userName ? initialsOf(userName) : '?';

  const menu = (
    <>
      {groups.map((group) => (
        <div key={group.label} className="mb-5">
          <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {group.label}
          </p>
          <ul className="space-y-1">
            {group.items.map((item) => {
              const under =
                pathname === item.href || (!item.exact && pathname.startsWith(`${item.href}/`));
              const here = under && !(item.except ?? []).some((path) => pathname.startsWith(path));
              return (
                <li key={item.href} className="flex items-center gap-1">
                  <Link
                    href={item.href}
                    aria-current={here ? 'page' : undefined}
                    className={`block min-w-0 flex-1 rounded-lg px-3 py-2 text-sm ${
                      here
                        ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                        : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'
                    }`}
                  >
                    {item.label}
                  </Link>
                  {item.plus ? (
                    <Link
                      href={item.plus.href}
                      aria-label={item.plus.label}
                      title={item.plus.label}
                      className="flex items-center gap-0.5 rounded-md border border-gray-300 px-1.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
                    >
                      <Icon path={ICONS.plus} className="h-3.5 w-3.5" strokeWidth={2.4} />
                      New
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {group.extra ? <div className="mt-2">{group.extra}</div> : null}
        </div>
      ))}

      <p className="mt-auto truncate px-2 text-xs text-gray-500" title={version}>
        {version}
      </p>
    </>
  );

  // Below lg the column does not exist, so the hamburger opens the drawer;
  // above it, the same button shows or hides the column.
  const columnOpen = pinned && !isNarrow;

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-gray-200 bg-white/90 px-4 backdrop-blur dark:border-gray-800 dark:bg-black/80">
        <button
          type="button"
          aria-label={columnOpen ? 'Hide menu' : 'Open menu'}
          aria-expanded={isNarrow ? open : columnOpen}
          onClick={() => (isNarrow ? setOpen(true) : togglePinned())}
          className="flex h-9 w-9 flex-col items-center justify-center gap-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900"
        >
          <span className="h-0.5 w-5 rounded bg-gray-700 dark:bg-gray-300" />
          <span className="h-0.5 w-5 rounded bg-gray-700 dark:bg-gray-300" />
          <span className="h-0.5 w-5 rounded bg-gray-700 dark:bg-gray-300" />
        </button>

        <Link href={`/${slug}`} className="flex items-center gap-2 font-semibold tracking-tight">
          <RenkeiMark className="h-6 w-6 shrink-0" />
          Renkei
          <span className="text-sm font-normal text-gray-500 dark:text-gray-400">{slug}</span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          {userName ? (
            <div ref={menuRef} className="relative">
              <button
                type="button"
                title={userName}
                aria-label="Account menu"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((o) => !o)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white ring-blue-300 hover:ring-2 dark:ring-blue-800"
              >
                {initials}
              </button>
              {/*
                Blue, not red. Red means an error everywhere else in this app
                — the issue counts on every builder node — and an unread
                notification is not one. Capped at 9+ so the dot stays a dot.
              */}
              {unread > 0 ? (
                <span
                  aria-label={`${unread} unread notification${unread === 1 ? '' : 's'}`}
                  className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold text-white ring-2 ring-white dark:ring-gray-950"
                >
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}

              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-10 z-40 w-60 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-800 dark:bg-gray-950"
                >
                  <div className="border-b border-gray-200 px-4 py-2 dark:border-gray-800">
                    <p className="truncate text-sm font-medium" title={userName}>
                      {userName}
                    </p>
                    {userEmail && userEmail !== userName && (
                      <p className="truncate text-xs text-gray-500" title={userEmail}>
                        {userEmail}
                      </p>
                    )}
                  </div>
                  {accountGroups.map((group, index) => (
                    <div
                      key={index}
                      className={
                        index > 0 ? 'border-t border-gray-200 dark:border-gray-800' : undefined
                      }
                    >
                      {group.map((item) => (
                        <Link
                          key={item.href}
                          href={item.href}
                          role="menuitem"
                          className="flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-900"
                        >
                          {item.label}
                          {item.label === 'Notifications' && unread > 0 ? (
                            <span className="rounded-full bg-blue-100 px-1.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                              {unread > 9 ? '9+' : unread}
                            </span>
                          ) : null}
                        </Link>
                      ))}
                    </div>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void signOut()}
                    disabled={signingOut}
                    className="block w-full border-t border-gray-200 px-4 py-2 text-left text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-800 dark:hover:bg-gray-900"
                  >
                    {signingOut ? 'Signing out…' : 'Sign out'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <a
              href={signInHref}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Sign in
            </a>
          )}
        </div>
      </header>

      {/* Backdrop, below lg only */}
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity lg:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden="true"
      />

      {/* Slides in from the left edge via `left`, not `transform` — a
          transform on this ancestor would create a new containing block
          for any `position: fixed` dialog opened from within it (e.g. the
          chat list's rename modal), clipping it to the drawer's own
          narrow, scrollable box instead of the viewport. */}
      <nav
        ref={drawerRef}
        tabIndex={-1}
        aria-label="Application"
        className={`fixed inset-y-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-gray-200 bg-white p-4 outline-none transition-[left] duration-200 ease-out lg:hidden dark:border-gray-800 dark:bg-gray-950 ${
          open ? 'left-0' : '-left-full'
        }`}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="flex items-center gap-2 font-semibold">
            <RenkeiMark className="h-6 w-6 shrink-0" />
            Renkei
          </span>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="rounded-lg px-2 py-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900"
          >
            ✕
          </button>
        </div>
        {menu}
      </nav>

      <div className="flex items-start">
        {/* The column — the same menu, standing beside the page from lg up */}
        {pinned ? (
          <nav
            aria-label="Application"
            className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-72 shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white p-4 lg:flex dark:border-gray-800 dark:bg-gray-950"
          >
            {menu}
          </nav>
        ) : null}
        {/* Wide enough for the log and grant tables; narrow pages center a
            max-w-3xl block of their own inside it. */}
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
      </div>
    </>
  );
}
