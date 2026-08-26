'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import RenkeiMark from '@/components/renkei-mark';
import { useNotifications } from '@/components/notification-center';

interface NavProps {
  slug: string;
  tenantId: string;
  /** Display name from the identity spine, falling back to email/subject. */
  userName: string | null;
  userEmail: string | null;
  isOperator: boolean;
  signInHref: string;
}

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
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The app-wide navigation: a top bar with the hamburger, org name, and the
 * user; a drawer that slides in from the left edge with the sections stacked.
 * Admin entries appear only for operators — the pages behind them still guard
 * themselves, the nav just does not advertise doors the user cannot open.
 */
export default function AppNav({
  slug,
  tenantId,
  userName,
  userEmail,
  isOperator,
  signInHref,
}: NavProps) {
  const [open, setOpen] = useState(false);
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

  const groups: NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { href: `/${slug}`, label: 'Home' },
        { href: `/${slug}/connectors`, label: 'Connectors' },
        { href: `/${slug}/knowledge`, label: 'Knowledge' },
        { href: `/${slug}/agents`, label: 'Agents' },
        { href: `/${slug}/usage`, label: 'Tools' },
        // Mail review is deliberately unlinked, not removed: it is the only
        // place a person can correct how their own mail was classified, and
        // there is no admin equivalent by design. The route still works for
        // anyone who has it bookmarked or is sent there.
        { href: `/${slug}/logs`, label: 'Activity' },
      ],
    },
    ...(isOperator
      ? [
          {
            label: 'Organization',
            items: [
              { href: `/${slug}/admin/connectors`, label: 'Connector setup' },
              { href: `/${slug}/admin/file-shares`, label: 'File shares' },
              { href: `/${slug}/admin/agents`, label: 'Agent oversight' },
              { href: `/${slug}/admin/llm-models`, label: 'Agent models' },
              { href: `/${slug}/admin/calendars`, label: 'Holiday calendars' },
              { href: `/${slug}/admin/email-sanitizer`, label: 'Email sanitizer' },
              { href: `/${slug}/admin/redaction`, label: 'Sensitive data' },
              { href: `/${slug}/admin/people`, label: 'People' },
              { href: `/${slug}/admin/sites`, label: 'Sites' },
              { href: `/${slug}/admin/audit`, label: 'Audit' },
              { href: `/${slug}/admin/events`, label: 'Events' },
              { href: `/${slug}/admin/settings`, label: 'Settings' },
            ],
          },
        ]
      : []),
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

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-gray-200 bg-white/90 px-4 backdrop-blur dark:border-gray-800 dark:bg-black/80">
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={open}
          onClick={() => setOpen(true)}
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
                  <Link
                    href={`/${slug}/notifications`}
                    role="menuitem"
                    className="flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-900"
                  >
                    Notifications
                    {unread > 0 ? (
                      <span className="rounded-full bg-blue-100 px-1.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                        {unread > 9 ? '9+' : unread}
                      </span>
                    ) : null}
                  </Link>
                  <Link
                    href={`/${slug}/preferences`}
                    role="menuitem"
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-900"
                  >
                    Preferences
                  </Link>
                  <Link
                    href={`/${slug}/about`}
                    role="menuitem"
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-900"
                  >
                    About
                  </Link>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void signOut()}
                    disabled={signingOut}
                    className="block w-full px-4 py-2 text-left text-sm hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-900"
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

      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden="true"
      />

      {/* Drawer — slides in from the left edge */}
      <nav
        ref={drawerRef}
        tabIndex={-1}
        aria-label="Application"
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-gray-200 bg-white p-4 outline-none transition-transform duration-200 ease-out dark:border-gray-800 dark:bg-gray-950 ${
          open ? 'translate-x-0' : '-translate-x-full'
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

        {groups.map((group) => (
          <div key={group.label} className="mb-6">
            <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {group.label}
            </p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const here = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`block rounded-lg px-3 py-2 text-sm ${
                        here
                          ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900'
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {userName && (
          <p className="mt-auto truncate px-2 text-xs text-gray-500" title={userName}>
            {userName}
          </p>
        )}
      </nav>
    </>
  );
}
