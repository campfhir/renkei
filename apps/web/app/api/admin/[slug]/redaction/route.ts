/**
 * Org-admin configuration of the redaction gate.
 *
 * Three settings, and the split between them is deliberate. Whether redaction
 * runs at all is one switch. Which detectors run is a second, because two of
 * them — patient names and phone numbers — are precise enough only for orgs
 * that know their own text. Site-specific MRN shapes are the third, because no
 * amount of cleverness can infer that a given site's record numbers look like
 * `A-1234567`.
 *
 * Nothing here accepts or returns example content. An admin configuring a
 * filter does not need to see what it caught, and a route that echoed samples
 * back would recreate the exposure the filter exists to remove.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getOrgSettings, setOrgSettings } from '@renkei/settings';
import { knownDetectors } from '@renkei/redaction';

/** A pattern we are willing to hand to the RegExp constructor. */
function usablePattern(source: string): boolean {
  if (source.length === 0 || source.length > 200) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const settings = await getOrgSettings(tenantRef.id);
  if (!settings.ok) {
    return NextResponse.json({ error: 'Could not read org settings' }, { status: 500 });
  }
  return NextResponse.json({
    enabled: settings.val.redactionEnabled,
    detectors: settings.val.redactionDetectors,
    mrnPatterns: settings.val.redactionMrnPatterns,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }

  const updates: Parameters<typeof setOrgSettings>[1] = {};

  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }
    updates.redactionEnabled = body.enabled;
  }

  if ('detectors' in body) {
    const submitted = body.detectors;
    if (!Array.isArray(submitted) || submitted.some((d) => typeof d !== 'string')) {
      return NextResponse.json({ error: 'detectors must be strings' }, { status: 400 });
    }
    // Filtered to what this build knows, so an unrecognised name is rejected
    // at the door rather than stored and silently doing nothing forever.
    const strings: string[] = [];
    for (const value of submitted) {
      if (typeof value === 'string') strings.push(value);
    }
    updates.redactionDetectors = knownDetectors(strings);
  }

  if ('mrnPatterns' in body) {
    const submitted = body.mrnPatterns;
    if (!Array.isArray(submitted) || submitted.some((p) => typeof p !== 'string')) {
      return NextResponse.json({ error: 'mrnPatterns must be strings' }, { status: 400 });
    }
    const patterns: string[] = [];
    for (const value of submitted) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;
      // Rejected here rather than skipped at match time: an admin who typed a
      // broken pattern should be told, not left believing it is protecting
      // them. The detector still skips bad ones defensively, for rows written
      // before this check existed.
      if (!usablePattern(trimmed)) {
        return NextResponse.json(
          { error: `Not a usable pattern: ${trimmed.slice(0, 60)}` },
          { status: 400 }
        );
      }
      patterns.push(trimmed);
    }
    updates.redactionMrnPatterns = patterns;
  }

  const saved = await setOrgSettings(tenantRef.id, updates);
  if (!saved.ok) {
    return NextResponse.json({ error: 'Could not save settings' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
