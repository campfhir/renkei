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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
