import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { ROLE_OPERATOR } from '@/lib/access';
import { getIdentityDisplay } from '@/lib/identity';
import { signInUrl } from '@/lib/sign-in-url';
import { PATHNAME_HEADER, safeReturnPath } from '@/lib/return-path';
import { getCoachMarkPrefs, getNotificationPrefs, getThemePrefs } from '@renkei/user-prefs';
import { getDatabase } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { chatSidebarActiveSince, loadChatSidebar } from '@/lib/chat/sidebar';
import { listCoachMarkProgress } from '@/lib/coach-marks/store';
import CoachMarkProvider from '@/components/coach-marks/provider';
import { NotificationCenter } from '@/components/notification-center';
import NotificationCorner from '@/components/notification-corner';
import DesktopNotifications from '@/components/desktop-notifications';
import ThemeScript from '@/components/theme-script';
import ThemeSync from '@/components/theme-sync';
import { getVersionInfo } from '@/lib/version-info';
import AppNav from './nav';

/**
 * Overrides the root layout's `<link rel="manifest">` (app/manifest.ts,
 * `start_url: '/'`) with one scoped to this tenant. Installing the PWA from
 * inside a tenant and launching it from the home screen icon has to land
 * back on `/[slug]`, not on "/" — "/" is the tenant-less sign-in form and
 * never checks a session cookie, so landing there always looks signed out
 * even when this tenant's session is still perfectly valid.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { manifest: `/api/manifest/${slug}` };
}

/**
 * The shell every tenant page shares: top bar, the menu (a column beside
 * the page on a wide screen, a drawer below it), sign-out.
 *
 * Resolves the slug once and passes ids down through the nav; pages resolve it
 * again for their own data — cheap, and it keeps each page correct when
 * rendered in isolation.
 *
 * This is also where a signed-out visitor is turned away, and the reason it
 * has to be here rather than only in the pages: every page sits behind its
 * own loading.tsx, which is a Suspense boundary, so by the time a page's
 * guard runs the shell around it — nav, skeleton — has already streamed to
 * the browser. The redirect then arrives as a client-side hop, and what the
 * person sees is a flash of the app before the sign-in page. The layout
 * sits above that boundary: a redirect thrown here is a plain 307 and
 * nothing renders first. Every `/[slug]/*` page requires a session, so
 * there is no allowlist to keep.
 *
 * The pages keep their own guards regardless. A layout does not re-render
 * on a client-side navigation, so a session that expires between two
 * pages is caught by the page, not here — lib/route-auth-coverage.test.ts
 * holds every page to that.
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
  if (!session) {
    // Back to the page they asked for, query and all — the proxy put it on
    // the request. Without it (the proxy's own error path), the home page.
    const requested = safeReturnPath((await headers()).get(PATHNAME_HEADER));
    redirect(signInUrl(tenant.id, requested ?? `/${tenant.slug}`));
  }
  const isOperator = session.roles.includes(ROLE_OPERATOR);

  // The nav shows a person, not an OIDC subject: the identity spine has the
  // display name and email recorded at sign-in. The subject is the fallback
  // for a session recorded before the spine existed.
  const identity = await getIdentityDisplay(tenant.id, session.subject);
  const userName = identity?.displayName ?? identity?.email ?? session.subject;

  const prefs = await getNotificationPrefs(tenant.id, session.subject, { fresh: true });
  const theme = await getThemePrefs(tenant.id, session.subject, { fresh: true });
  const coachMarks = await getCoachMarkPrefs(tenant.id, session.subject, { fresh: true });
  // The org's switch for the tours (the escape hatch) — off, the engine
  // mounts inert and the Tutorials door goes away. A settings read that
  // fails reads as on: the switch is for a misbehaving tour, not a
  // misbehaving database.
  const orgSettings = await getOrgSettings(tenant.id);
  const coachMarksEnabled = orgSettings.ok ? orgSettings.val.coachMarksEnabled : true;

  // The menu carries the person's chats on every page, and the coach-mark
  // engine needs to know which tours this person has already settled.
  const dbResult = getDatabase();
  const [chats, coachMarkProgress] = dbResult.ok
    ? await Promise.all([
        loadChatSidebar(dbResult.val, tenant.id, session.subject, {
          since: chatSidebarActiveSince(),
        }),
        listCoachMarkProgress(dbResult.val, tenant.id, session.subject),
      ])
    : [null, []];

  const version = getVersionInfo();

  /*
    The notification centre wraps the nav AND the page, because both read
    the same poll: the nav wants the unread count, the toast stack wants
    what has arrived since this tab opened. One poller, two readers.

    ThemeScript has to be the very first thing this layout renders — see
    its own comment. ThemeSync follows it: it is what guarantees
    `data-theme` exists when the script never ran (a client-side mount of
    this layout).
  */
  return (
    <>
      <ThemeScript tenantId={tenant.id} />
      <ThemeSync tenantId={tenant.id} mode={theme.mode} />
      <NotificationCenter tenantId={tenant.id}>
        <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-black dark:text-gray-100">
          {/* The nav frames the page: it owns the <main> so the menu column can
              stand beside it on a wide screen. */}
          {/* The coach marks wrap the nav AND the page: a tour spotlights
              both, and walks across pages without unmounting. */}
          <CoachMarkProvider
            slug={tenant.slug}
            tenantId={tenant.id}
            isOperator={isOperator}
            enabled={coachMarksEnabled}
            autoStart={coachMarks.autoStart}
            progress={coachMarkProgress}
          >
            <AppNav
              slug={tenant.slug}
              tenantId={tenant.id}
              userName={userName}
              userEmail={identity?.email ?? null}
              isOperator={isOperator}
              chats={chats}
              version={version}
            >
              {children}
            </AppNav>
          </CoachMarkProvider>
          <NotificationCorner
            tenantId={tenant.id}
            corner={prefs?.toastCorner ?? 'bottom-right'}
            toastsEnabled={prefs?.toastsEnabled ?? false}
          />
          {/* Renders nothing — it only turns arrivals into OS banners while the
              tab is in the background, and only for somebody whose browser has
              granted permission. The opt-in it checks lives in this browser's
              localStorage, not here — see desktop-notifications.tsx. */}
          <DesktopNotifications tenantId={tenant.id} />
        </div>
      </NotificationCenter>
    </>
  );
}
