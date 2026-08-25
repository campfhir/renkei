/**
 * Org-admin CRUD over sandboxed cleaner scripts — `(email) => string`
 * functions run in the QuickJS WASM sandbox as a cleaning stage. Saving
 * validates the SOURCE (it must parse and be a function) but not runtime
 * behavior; the test route exists for that, and a failing script in
 * production is a recorded no-op, never lost mail. Audited: a script
 * rewrites what gets indexed for the whole org, which is exactly the kind
 * of change someone later asks "who did that" about.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import {
  listCleanerScripts,
  upsertCleanerScript,
  validateCleanerScriptSource,
  MAX_SCRIPT_CHARS,
} from '@renkei/email-sanitizer';
import { recordAuditEvent } from '@/lib/audit-events';
import { describeKinds, parseContentKinds } from '@/lib/email-sanitizer/content-kinds';

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

  const scripts = await listCleanerScripts(tenantRef.id);
  if (!scripts.ok) {
    return NextResponse.json({ error: 'Could not read scripts' }, { status: 500 });
  }
  return NextResponse.json({ scripts: scripts.val });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const payload: {
    id?: unknown;
    name?: unknown;
    script?: unknown;
    enabled?: unknown;
    appliesTo?: unknown;
  } = typeof body === 'object' && body !== null ? body : {};

  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : '';
  if (!name) return NextResponse.json({ error: 'Give the script a name.' }, { status: 400 });
  const script = typeof payload.script === 'string' ? payload.script : '';
  if (!script.trim()) {
    return NextResponse.json({ error: 'Write the script first.' }, { status: 400 });
  }
  if (script.length > MAX_SCRIPT_CHARS) {
    return NextResponse.json(
      { error: `Scripts are capped at ${MAX_SCRIPT_CHARS.toLocaleString()} characters.` },
      { status: 400 }
    );
  }

  const valid = await validateCleanerScriptSource(script);
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 422 });

  const appliesTo = parseContentKinds(payload.appliesTo);
  const saved = await upsertCleanerScript(tenantRef.id, {
    ...(typeof payload.id === 'string' && payload.id ? { id: payload.id } : {}),
    name,
    script,
    enabled: payload.enabled !== false,
    appliesTo,
  });
  if (!saved.ok) return NextResponse.json({ error: 'Could not save' }, { status: 500 });

  recordAuditEvent({
    tenantId: tenantRef.id,
    actorSubject: access.subject,
    action: 'sanitizer.script_saved',
    targetKind: 'cleaner-script',
    // The reach is the part someone audits after the fact: the same script
    // over mail alone and over every kind are very different decisions.
    targetLabel: `${name} (${describeKinds(appliesTo)})`,
  });
  return NextResponse.json({ script: saved.val });
}
