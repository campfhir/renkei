/**
 * The artifact routes share one body each (the grant-routes.ts idiom):
 * the library, one artifact (details, rename, replace, delete or leave),
 * its shares, hand-over and copy, and a project's attachments. Every
 * route resolves the caller's access through artifact-access.ts and
 * answers 404 — never 403 — for what they may not see, matching the
 * structural-ownership rule everywhere else; 403 is kept for what they
 * can see but may not change.
 */

import type { NextRequest } from 'next/server';
import { NextResponse, after } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { isUuid } from '@/lib/uuid';
import { isGrantRole } from './access';
import { isReferenceMode, listProjectArtifacts, type ReferenceMode } from './attachments';
import { resolveArtifactAccess } from './artifact-access';
import { claimArtifactOcr, ocrRefusalFor, runArtifactOcr, type OcrRefusal } from './artifact-ocr';
import {
  ALWAYS_BUDGET_TOKENS,
  alwaysTokensOf,
  artifactImpact,
  attachToProject,
  copyArtifact,
  deleteArtifact,
  detachFromProject,
  leaveArtifact,
  libraryItemFor,
  listArtifactGrants,
  listLibrary,
  renameArtifact,
  replaceArtifactBytes,
  revokeArtifactShare,
  setProjectArtifactMode,
  shareArtifact,
  transferArtifact,
  type ArtifactActError,
} from './artifact-library';
import { deferDigest } from './artifact-digest';
import { parseLibraryQuery } from './artifact-library-params';
import { queryLibrary } from './artifact-library-query';
import { createOutboundRedactor } from './outbound-redaction';
import { parseExpiry } from './grant-input';
import { resolveProjectAccess } from './access';
import { chatRequestContext, jsonError, readJsonBody } from './route-support';

function actError(error: ArtifactActError): Response {
  switch (error) {
    case 'NOT_FOUND':
      return jsonError(404, 'not-found', 'No such file');
    case 'FORBIDDEN':
      return jsonError(403, 'forbidden', 'You may use this file, not change it.');
    case 'CONTENT_KEY':
      return jsonError(
        409,
        'content-key',
        'The file’s text could not be re-keyed. Its owner has to be signed in for this.'
      );
    case 'UNCONFIGURED':
      return jsonError(503, 'uploads-off', 'File storage is not set up.');
    case 'STORE':
      return jsonError(502, 'store', 'The file store refused.');
    case 'SELF':
      return jsonError(400, 'self', 'That is you');
    case 'BUDGET':
      return jsonError(
        409,
        'budget',
        `Keeping this file in context would exceed the project’s ${Math.round(ALWAYS_BUDGET_TOKENS / 1000)}k-token budget. Make room, or use it on demand.`
      );
    case 'INVALID':
      return jsonError(400, 'invalid', 'This file has no text to keep in context.');
  }
}

const modeOf = (value: unknown): ReferenceMode => (isReferenceMode(value) ? value : 'on_demand');

/**
 * GET: a page of the library, chosen by the same parameters the page's
 * URL carries (artifact-library-params.ts) — or, with `all=1`, the whole
 * of it, for a picker that lists everything at once.
 */
export async function listLibraryRoute(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const params = request.nextUrl.searchParams;
  const uploads = await tenantBlobStoreConfigured();
  if (params.get('all') === '1') {
    return NextResponse.json({ artifacts: await listLibrary(db, session.subject), uploads });
  }
  const page = await queryLibrary(db, session.subject, parseLibraryQuery(params));
  return NextResponse.json({ ...page, uploads });
}

export async function artifactDetailRoute(
  request: NextRequest,
  artifactId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveArtifactAccess(db, session.subject, artifactId);
  if (!access) return jsonError(404, 'not-found', 'No such file');
  const item = await libraryItemFor(db, session.subject, access);
  if (!item) return jsonError(404, 'not-found', 'No such file');
  const owner = access.role === 'owner';
  return NextResponse.json({
    artifact: item,
    access: { role: access.role, via: access.via, projectId: access.projectId },
    impact: owner ? await artifactImpact(db, access.row) : null,
    grants: owner ? await listArtifactGrants(db, session.subject, artifactId) : [],
  });
}

export async function renameArtifactRoute(
  request: NextRequest,
  artifactId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
  if (!filename) return jsonError(400, 'invalid', 'Give the file a name');
  const access = await resolveArtifactAccess(db, session.subject, artifactId);
  if (!access) return jsonError(404, 'not-found', 'No such file');
  if (access.role !== 'owner') return actError('FORBIDDEN');
  await renameArtifact(db, { ownerSubject: session.subject, artifactId, filename });
  return NextResponse.json({ ok: true });
}

/** PUT with raw bytes: the owner replaces the file, keeping every attachment and share. */
export async function replaceArtifactRoute(
  request: NextRequest,
  artifactId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveArtifactAccess(db, session.subject, artifactId);
  if (!access) return jsonError(404, 'not-found', 'No such file');
  if (access.role !== 'owner') return actError('FORBIDDEN');
  const settingsResult = await getOrgSettings();
  const settings = settingsResult.ok ? settingsResult.val : null;
  const maxBytes = settings?.maxAttachmentBytes ?? 20_971_520;
  const url = new URL(request.url);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return jsonError(400, 'empty', 'The file is empty.');
  if (bytes.byteLength > maxBytes) {
    return jsonError(
      413,
      'too-large',
      `Files are limited to ${Math.round(maxBytes / 1_048_576)} MB.`
    );
  }
  const replaced = await replaceArtifactBytes(db, {
    access,
    bytes,
    contentType:
      url.searchParams.get('contentType') ??
      request.headers.get('content-type') ??
      'application/octet-stream',
    filename: url.searchParams.get('filename'),
    maxBytes,
    redactor: settings ? createOutboundRedactor(settings) : null,
  });
  if (!replaced.ok) return actError(replaced.err.type);
  deferDigest(db, session.subject, [replaced.val], after);
  return NextResponse.json({ ok: true, extractStatus: replaced.val.extractStatus });
}

/** DELETE: the owner removes it for everyone; a person it was shared with takes it off their list. */
export async function deleteArtifactRoute(
  request: NextRequest,
  artifactId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveArtifactAccess(db, session.subject, artifactId);
  if (!access) return jsonError(404, 'not-found', 'No such file');
  if (access.role === 'owner') {
    await deleteArtifact(db, access.row);
    return NextResponse.json({ ok: true, outcome: 'deleted' });
  }
  if (access.role === 'use') {
    await leaveArtifact(db, { subject: session.subject, artifactId });
    return NextResponse.json({ ok: true, outcome: 'left' });
  }
  return actError('FORBIDDEN');
}

/**
 * Starts OCR on a file the owner holds. The answer comes back at once with
 * 202; the read runs after it, and the library shows its progress.
 */
export async function startOcrRoute(request: NextRequest, artifactId: string): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveArtifactAccess(db, session.subject, artifactId);
  if (!access) return jsonError(404, 'not-found', 'No such file');
  if (access.role !== 'owner') return actError('FORBIDDEN');
  const refusal = ocrRefusalFor(access) ?? (await claimArtifactOcr(db, artifactId));
  if (refusal) {
    const message: Record<OcrRefusal, string> = {
      unsupported: 'OCR reads PDFs and images only.',
      'already-read': 'This file already has its text.',
      unconfigured: 'OCR is not set up for this organization.',
      running: 'OCR is already running on this file.',
    };
    const status = refusal === 'unconfigured' ? 503 : refusal === 'running' ? 409 : 422;
    return jsonError(status, refusal, message[refusal]);
  }
  after(() => runArtifactOcr(db, artifactId, session.subject));
  return NextResponse.json({ ok: true }, { status: 202 });
}

export async function impactRoute(request: NextRequest, artifactId: string): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveArtifactAccess(db, session.subject, artifactId);
  if (!access || access.role !== 'owner') return jsonError(404, 'not-found', 'No such file');
  return NextResponse.json({ impact: await artifactImpact(db, access.row) });
}

export async function transferRoute(request: NextRequest, artifactId: string): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const newOwnerSubject =
    typeof body.newOwnerSubject === 'string' ? body.newOwnerSubject.trim() : '';
  if (!newOwnerSubject) return jsonError(400, 'invalid', 'Choose a person');
  const result = await transferArtifact(db, {
    ownerSubject: session.subject,
    artifactId,
    newOwnerSubject,
  });
  if (!result.ok) return actError(result.err.type);
  return NextResponse.json({ ok: true });
}

export async function copyRoute(request: NextRequest, artifactId: string): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const settingsResult = await getOrgSettings();
  const settings = settingsResult.ok ? settingsResult.val : null;
  const attachProjectId =
    typeof body.attachProjectId === 'string' && isUuid(body.attachProjectId)
      ? body.attachProjectId
      : null;
  const result = await copyArtifact(db, {
    actorSubject: session.subject,
    artifactId,
    filename: typeof body.filename === 'string' && body.filename.trim() ? body.filename : null,
    attachProjectId,
    mode: modeOf(body.mode),
    maxBytes: settings?.maxAttachmentBytes ?? 20_971_520,
    redactor: settings ? createOutboundRedactor(settings) : null,
  });
  if (!result.ok) {
    return result.err.type === 'SELF'
      ? jsonError(400, 'self', 'It is yours already; a copy is for a file someone shared with you.')
      : actError(result.err.type);
  }
  // A copy of an undigested file is digested as the copier's own.
  deferDigest(db, session.subject, [result.val], after);
  return NextResponse.json({ ok: true, artifactId: result.val.id }, { status: 201 });
}

export async function listArtifactGrantsRoute(
  request: NextRequest,
  artifactId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  return NextResponse.json({
    grants: await listArtifactGrants(db, session.subject, artifactId),
  });
}

export async function addArtifactGrantRoute(
  request: NextRequest,
  artifactId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const granteeSubject = typeof body.granteeSubject === 'string' ? body.granteeSubject.trim() : '';
  if (!granteeSubject) return jsonError(400, 'invalid', 'Choose a person');
  // Artifacts are shared to use, never to edit; a role sent along is ignored.
  void isGrantRole;
  const expiresAt = parseExpiry(body.expiresAt);
  if (expiresAt === undefined) return jsonError(400, 'invalid', 'Invalid expiry');
  const result = await shareArtifact(db, {
    ownerSubject: session.subject,
    artifactId,
    granteeSubject,
    expiresAt,
  });
  if (!result.ok) return actError(result.err.type);
  return NextResponse.json({ ok: true });
}

export async function revokeArtifactGrantRoute(
  request: NextRequest,
  artifactId: string,
  grantId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const revoked = await revokeArtifactShare(db, {
    ownerSubject: session.subject,
    artifactId,
    grantId,
  });
  if (!revoked) return jsonError(404, 'not-found', 'No such share');
  return NextResponse.json({ ok: true });
}

/** A project's artifacts with how each is used, and the "always" budget. */
export async function listProjectArtifactsRoute(
  request: NextRequest,
  projectId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  if (!isUuid(projectId)) return jsonError(404, 'not-found', 'No such project');
  const access = await resolveProjectAccess(db, session.subject, projectId);
  if (!access) return jsonError(404, 'not-found', 'No such project');
  const rows = await listProjectArtifacts(db, projectId);
  return NextResponse.json({
    artifacts: rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      extractStatus: row.extractStatus,
      origin: row.origin,
      ownerSubject: row.ownerSubject,
      mode: row.mode,
      createdAt: row.createdAt.toISOString(),
    })),
    alwaysTokens: { used: await alwaysTokensOf(db, projectId), budget: ALWAYS_BUDGET_TOKENS },
    role: access.role,
  });
}

export async function attachArtifactRoute(
  request: NextRequest,
  projectId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const artifactId = typeof body.artifactId === 'string' ? body.artifactId : '';
  if (!isUuid(artifactId) || !isUuid(projectId)) return jsonError(404, 'not-found', 'No such file');
  const result = await attachToProject(db, {
    actorSubject: session.subject,
    artifactId,
    projectId,
    mode: modeOf(body.mode),
  });
  if (!result.ok) return actError(result.err.type);
  return NextResponse.json({ ok: true, mode: result.val.mode });
}

export async function setArtifactModeRoute(
  request: NextRequest,
  projectId: string,
  artifactId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  if (!isReferenceMode(body.mode)) return jsonError(400, 'invalid', 'Say always or on_demand');
  if (!isUuid(artifactId) || !isUuid(projectId)) return jsonError(404, 'not-found', 'No such file');
  const result = await setProjectArtifactMode(db, {
    actorSubject: session.subject,
    artifactId,
    projectId,
    mode: body.mode,
  });
  if (!result.ok) return actError(result.err.type);
  return NextResponse.json({ ok: true, alwaysTokens: await alwaysTokensOf(db, projectId) });
}

export async function detachArtifactRoute(
  request: NextRequest,
  projectId: string,
  artifactId: string
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  if (!isUuid(artifactId) || !isUuid(projectId)) return jsonError(404, 'not-found', 'No such file');
  const result = await detachFromProject(db, {
    actorSubject: session.subject,
    artifactId,
    projectId,
  });
  if (!result.ok) return actError(result.err.type);
  return NextResponse.json({ ok: true });
}
