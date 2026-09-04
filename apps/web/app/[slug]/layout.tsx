import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { ROLE_OPERATOR } from '@/lib/access';
import { getIdentityDisplay } from '@/lib/identity';
import { signInUrl } from '@/lib/sign-in-url';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { getDatabase } from '@renkei/db';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { NotificationCenter } from '@/components/notification-center';
import NotificationCorner from '@/components/notification-corner';
import DesktopNotifications from '@/components/desktop-notifications';
import AppNav from './nav';

/**
 * The shell every tenant page shares: top bar, the menu (a column beside
 * the page on a wide screen, a drawer below it), sign-out.
 *
 * Resolves the slug once and passes ids down through the nav; pages resolve it
 * again for their own data — cheap, and it keeps each page correct when
 * rendered in isolation. No auth redirect happens here: the admin sign-in
 * flow lives under this layout and must be reachable signed-out, so each page
 * guards itself and the nav simply renders for whoever is present.
 */
export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  const isOperator = session?.roles.includes(ROLE_OPERATOR) ?? false;

  // The nav shows a person, not an OIDC subject: the identity spine has the
  // display name and email recorded at sign-in. The subject is the fallback
  // for a session recorded before the spine existed.
  const identity = session ? await getIdentityDisplay(tenant.id, session.subject) : null;
  const userName = identity?.displayName ?? identity?.email ?? session?.subject ?? null;

  const prefs = session
    ? await getNotificationPrefs(tenant.id, session.subject, { fresh: true })
    : null;

  // The menu carries the person's chats on every page.
  const dbResult = getDatabase();
  const chats =
    session && dbResult.ok ? await loadChatSidebar(dbResult.val, tenant.id, session.subject) : null;

  /*
    The notification centre wraps the nav AND the page, because both read
    the same poll: the nav wants the unread count, the toast stack wants
    what has arrived since this tab opened. One poller, two readers.

    Only for a signed-in visitor. This layout deliberately does not redirect
    when there is no session (the admin sign-in flow lives under it), so
    everything here has to tolerate its absence.
  */
  const shell = (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-black dark:text-gray-100">
      {/* The nav frames the page: it owns the <main> so the menu column can
          stand beside it on a wide screen. */}
      <AppNav
        slug={tenant.slug}
        tenantId={tenant.id}
        userName={userName}
        userEmail={identity?.email ?? null}
        isOperator={isOperator}
        signInHref={signInUrl(tenant.id, `/${tenant.slug}`)}
        chats={chats}
      >
        {children}
      </AppNav>
      {session ? (
        <NotificationCorner
          tenantId={tenant.id}
          corner={prefs?.toastCorner ?? 'bottom-right'}
          toastsEnabled={prefs?.toastsEnabled ?? false}
        />
      ) : null}
      {/* Renders nothing — it only turns arrivals into OS banners while the
          tab is in the background, and only for somebody whose browser has
          granted permission. The opt-in it checks lives in this browser's
          localStorage, not here — see desktop-notifications.tsx. */}
      {session ? <DesktopNotifications tenantId={tenant.id} /> : null}
    </div>
  );

  if (!session) return shell;
  return <NotificationCenter tenantId={tenant.id}>{shell}</NotificationCenter>;
}
