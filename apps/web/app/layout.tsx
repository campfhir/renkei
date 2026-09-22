import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

/**
 * The tab icon is NOT declared here: `app/icon.svg` is a Next file
 * convention, discovered and linked automatically. An `icons` entry would
 * only compete with it.
 */
export const metadata: Metadata = {
  title: {
    default: 'Renkei',
    // Pages that set their own title get the product name appended, so a
    // tab reads "Agents · Renkei" rather than losing the product entirely.
    template: '%s · Renkei',
  },
  description:
    'A permission-aware knowledge and action layer over the tools your organization already uses — WebEx, Outlook, SharePoint, Confluence, Zoom, and Jira.',
  applicationName: 'Renkei',
  // Every route behind this shell requires a session, and the sign-in
  // landing is nothing anyone should reach from a search result.
  robots: { index: false, follow: false },
  /**
   * Without this, "Add to Home Screen" on iOS makes a bookmark that opens
   * in ordinary Safari, not the standalone app the manifest (app/manifest.ts)
   * asks for. The distinction is not only chrome: voice mode's microphone
   * handling (lib/voice/audio-session.ts) depends on iOS actually treating
   * the page as a standalone web app rather than a Safari tab.
   */
  appleWebApp: {
    title: 'Renkei',
    statusBarStyle: 'black-translucent',
  },
  /**
   * `appleWebApp` above emits the current `mobile-web-app-capable`, which
   * iOS only reads from 17.4; this is the older tag it read for every
   * version before that, still worth sending since it costs nothing on a
   * version that ignores it.
   */
  other: {
    'apple-mobile-web-app-capable': 'yes',
  },
};

/**
 * `interactiveWidget: 'resizes-content'` asks the browser to shrink the
 * layout viewport when the on-screen keyboard opens (Chrome on Android
 * honours it; iOS Safari does not, and the chat handles that itself from
 * the visual viewport). Without it the keyboard covers whatever sits on
 * the bottom edge — the chat's message box, above all.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `data-theme` is put on <html> by the tenant layout's inline theme
    // script before React hydrates (components/theme-script.tsx), so the
    // attribute the browser has is never one the server rendered — which is
    // exactly the one place a hydration mismatch is expected and harmless.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
