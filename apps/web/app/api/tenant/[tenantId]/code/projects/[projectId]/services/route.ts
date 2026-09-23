/**
 * A code project's services — the containers running beside its
 * checkout — for the project's Services page: GET lists them (checked
 * against the engine as they are listed) with the images the
 * organization allows, or with `?view=summary` just what the project
 * page's card shows (any member); POST starts one (editors), the way a
 * chat's code_service_start would, so a person can have the database
 * up before asking for the work. One service by name — its logs, and
 * stopping it — is [name]/route.ts beside this.
 *
 * The worker is the authority on what may run: the image is matched
 * against the organization's rules there, with the registry credential
 * it holds; nothing here sees a credential, and the allow-list comes
 * back as patterns only.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  clientFailure,
  sandboxServicesEnabled,
  sbImageRulesList,
  sbServiceList,
  sbServiceStart,
} from '@renkei/sandbox-client';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import {
  allowedPatterns,
  parseServiceStartPayload,
  summarizeServices,
  type ServicesView,
} from '@/lib/code/services';
import { recordAuditEvent } from '@/lib/audit-events';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const summary = request.nextUrl.searchParams.get('view') === 'summary';
  const empty: ServicesView = { enabled: false, services: [], allowed: [] };
  if (!sandboxServicesEnabled()) {
    return NextResponse.json(summary ? summarizeServices(empty) : empty);
  }
  const target = codeProjectTarget(tenantId, projectId);
  const [listed, rules] = await Promise.all([sbServiceList(target), sbImageRulesList(tenantId)]);
  if (!listed.ok) {
    const failure = clientFailure(listed.err);
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  const view: ServicesView = {
    enabled: true,
    services: listed.val,
    allowed: rules.ok ? allowedPatterns(rules.val) : [],
  };
  return NextResponse.json(summary ? summarizeServices(view) : view);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId, { write: true });
  if (!ready.ok) return ready.response;
  if (!sandboxServicesEnabled()) {
    return jsonError(
      503,
      'unavailable',
      'Code project services are not enabled on this deployment.'
    );
  }
  const input = parseServiceStartPayload(await readJsonBody(request));
  if ('error' in input) return jsonError(400, 'invalid', input.error);
  const started = await sbServiceStart(codeProjectTarget(tenantId, projectId), input);
  if (!started.ok) {
    const failure = clientFailure(started.err);
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: ready.context.session.subject,
    action: 'code.services.started',
    targetKind: 'code_project',
    targetLabel: ready.context.project.name,
    details: {
      projectId,
      name: started.val.name,
      image: started.val.image,
      exports: started.val.exportNames,
    },
  });
  return NextResponse.json({ service: started.val }, { status: 201 });
}
