import type { MetadataRoute } from 'next';

/**
 * Shared by app/manifest.ts (the generic, tenant-less manifest served at "/")
 * and app/api/manifest/[slug]/route.ts (the per-tenant one linked from
 * app/[slug]/layout.tsx). Everything but `start_url` is the same either way.
 */
export function buildManifest(startUrl: string): MetadataRoute.Manifest {
  return {
    name: 'Renkei',
    short_name: 'Renkei',
    description:
      'A permission-aware knowledge and action layer over the tools your organization already uses.',
    start_url: startUrl,
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
