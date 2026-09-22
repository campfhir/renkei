import type { MetadataRoute } from 'next';

/**
 * Without this file iOS has no Web App Manifest to install from: "Add to
 * Home Screen" makes an ordinary bookmark that opens in Safari rather than
 * the standalone, chrome-less app the icon and the app-shell layout expect.
 * That distinction is not cosmetic here — voice mode's audio-session
 * handling (lib/voice/audio-session.ts) only exists for a page iOS has
 * actually put in its standalone runtime; `display: 'standalone'` is what
 * asks for that runtime in the first place.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Renkei',
    short_name: 'Renkei',
    description:
      'A permission-aware knowledge and action layer over the tools your organization already uses.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
    ],
  };
}
