import type { MetadataRoute } from 'next';
import { buildManifest } from '@/lib/app-manifest';

/**
 * Without this file iOS has no Web App Manifest to install from: "Add to
 * Home Screen" makes an ordinary bookmark that opens in Safari rather than
 * the standalone, chrome-less app the icon and the app-shell layout expect.
 * That distinction is not cosmetic here — voice mode's audio-session
 * handling (lib/voice/audio-session.ts) only exists for a page iOS has
 * actually put in its standalone runtime; `display: 'standalone'` is what
 * asks for that runtime in the first place.
 *
 * This is the fallback manifest, `start_url: '/'` — the home-realm sign-in
 * page, correct only when installed from there. Every `/[slug]/*` page
 * links a tenant-scoped manifest instead (app/api/manifest/[slug]/route.ts,
 * wired up in app/[slug]/layout.tsx's generateMetadata) so an icon added
 * from inside a tenant launches back into that tenant, not here: landing on
 * "/" skips the `/[slug]` layout entirely — the one place a session cookie
 * actually gets checked — so a still-signed-in person opening the installed
 * icon always saw the sign-in form and looked signed out.
 */
export default function manifest(): MetadataRoute.Manifest {
  return buildManifest('/');
}
