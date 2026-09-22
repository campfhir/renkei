/**
 * The Web App Manifest for a signed-in tenant path, linked from
 * app/[slug]/layout.tsx's generateMetadata in place of the generic one at
 * "/" (app/manifest.ts). `start_url` is this tenant's own home page, not
 * "/" — installing from inside a tenant and launching the icon has to land
 * back on a `/[slug]/*` route, the only place a session cookie is checked.
 *
 * No auth gate: a manifest is a public asset, fetched by the OS before any
 * page has run, same as the icon it points at.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tenantForSlug } from '@/lib/tenant-slug';
import { buildManifest } from '@/lib/app-manifest';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });

  return NextResponse.json(buildManifest(`/${tenant.slug}`), {
    headers: { 'Content-Type': 'application/manifest+json' },
  });
}
