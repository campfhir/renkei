/**
 * The project's environment — the variables its commands run with. GET
 * lists names and dates (any member). PUT replaces the whole set from
 * the text of a `.env` file (editors): the text is parsed here, the
 * pairs go to the sandbox worker once, the worker seals them, and this
 * process keeps and echoes nothing but the names. DELETE removes one
 * variable by name (editors).
 *
 * Deliberately NOT an MCP tool: the model may list the names, and the
 * worker puts the values in a command's environment, but supplying them
 * is a person's gesture, made here with their own session.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateEnvName } from '@renkei/connector-sandbox';
import { clientFailure, sandboxWorkspacesEnabled, sbEnvDelete } from '@renkei/sandbox-client';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { projectEnv, replaceProjectEnv } from '@/lib/code/projects';
import { codeProjectTarget } from '@/lib/code/scope';
import { recordAuditEvent } from '@/lib/audit-events';

const DOTENV_MAX_CHARS = 200_000;

async function projectFor(
  request: NextRequest,
  tenantId: string,
  projectId: string,
  edit: boolean
) {
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return { ok: false as const, response: ready.response };
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    tenantId,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access)
    return { ok: false as const, response: jsonError(404, 'not-found', 'No such project') };
  if (edit && access.role === 'viewer') {
    return {
      ok: false as const,
      response: jsonError(403, 'read-only', 'Only editors can change this project’s environment.'),
    };
  }
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project || project.kind !== 'code') {
    return { ok: false as const, response: jsonError(404, 'not-found', 'No such project') };
  }
  return { ok: true as const, project, session };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await projectFor(request, tenantId, projectId, false);
  if (!found.ok) return found.response;
  return NextResponse.json({ variables: await projectEnv(found.project) });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await projectFor(request, tenantId, projectId, true);
  if (!found.ok) return found.response;
  const body = await readJsonBody(request);
  const text = typeof body.env === 'string' ? body.env : '';
  if (text.length > DOTENV_MAX_CHARS) return jsonError(413, 'invalid', 'The .env is too large.');
  const replaced = await replaceProjectEnv(found.project, text);
  if (!replaced.ok) return jsonError(replaced.status, 'env', replaced.message);
  recordAuditEvent({
    tenantId,
    actorSubject: found.session.subject,
    action: 'code.env.replaced',
    targetKind: 'code_project',
    targetLabel: found.project.name,
    details: { projectId, names: replaced.val.variables.map((variable) => variable.name) },
  });
  return NextResponse.json({ variables: replaced.val.variables, problems: replaced.val.problems });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const found = await projectFor(request, tenantId, projectId, true);
  if (!found.ok) return found.response;
  if (!sandboxWorkspacesEnabled()) {
    return jsonError(503, 'unavailable', 'Code workspaces are not enabled on this deployment.');
  }
  const body = await readJsonBody(request);
  const name = validateEnvName(body.name);
  if (!name.ok) return jsonError(400, 'invalid', name.message);
  const deleted = await sbEnvDelete(codeProjectTarget(tenantId, projectId), name.name);
  if (!deleted.ok) {
    const failure = clientFailure(deleted.err);
    return jsonError(failure.status, 'env', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: found.session.subject,
    action: 'code.env.deleted',
    targetKind: 'code_project',
    targetLabel: found.project.name,
    details: { projectId, name: name.name },
  });
  return NextResponse.json({ ok: true });
}
