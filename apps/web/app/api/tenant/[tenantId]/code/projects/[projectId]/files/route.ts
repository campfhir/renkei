/**
 * One file of the project's repository, for the code pane.
 *
 * GET `?path=`: the file's text — from the checkout on the sandbox once
 * there is one (the working tree, uncommitted changes included, the same
 * bytes the chat's tools see), and before any chat has cloned, from
 * the repository's git host on the project's branch, read-only. Every answer carries an
 * `etag` (a hash of the text as read) that a save hands back, so a file
 * that moved underneath is never overwritten unasked. Any member may
 * read.
 *
 * PUT `?path=`: the body is the file, `path` says where in the
 * repository it lands, uncommitted — a person's file from Add files, or
 * a save from the code pane (`x-code-editor: save`, with `If-Match: <etag>`
 * from the read: 409 when the checkout's file no longer matches, with
 * the current etag so the pane can offer a reload or an overwrite). A
 * code project keeps no files of its own — what a chat should see
 * belongs in the repository, where a chat can commit it — so this is
 * the one way a person's bytes reach the project. Editors only.
 *
 * POST: `{path}` — an empty new file at `path` (the tree's "New file"),
 * refused if something is already there. Unlike PUT this never
 * overwrites, and unlike an upload it allows zero bytes — the whole
 * point is a blank file to start typing into.
 *
 * DELETE `?path=`: the file or folder at `path`, removed from the
 * checkout — recursively for a folder. 404 when there was nothing
 * there (the tree's own view can be a beat stale).
 *
 * PATCH: `{from, to}` — a file or folder renamed or moved within the
 * checkout. Refused (409) onto a destination that already exists — a
 * rename never silently overwrites.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  UPLOAD_MAX_BYTES,
  WRITE_MAX_CHARS,
  validateWorkspacePath,
} from '@renkei/connector-sandbox';
import {
  clientFailure,
  sandboxWorkspacesEnabled,
  sbWorkspaceMove,
  sbWorkspaceRead,
  sbWorkspaceRemove,
  sbWorkspaceUpload,
  sbWorkspaceWrite,
} from '@renkei/sandbox-client';
import { GITHUB } from '@renkei/provider-grants';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import {
  bitbucketAuthFor,
  readSourceFile as readBitbucketSourceFile,
} from '@/lib/code/bitbucket-browse';
import { githubAuthFor, readSourceFile as readGitHubSourceFile } from '@/lib/code/github-browse';
import { etagOf } from '@/lib/code/etag';
import { languageForPath } from '@/lib/code/language';
import { noteLanguageGap } from '@/lib/code/language-gaps';
import { projectWorkspace } from '@/lib/code/projects';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { recordAuditEvent } from '@/lib/audit-events';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { db, session, access, project } = ready.context;
  const path = validateWorkspacePath(new URL(request.url).searchParams.get('path'));
  if (!path.ok || !path.path)
    return jsonError(400, 'invalid', path.ok ? 'Say which file.' : path.message);
  const language = languageForPath(path.path);
  // A file the pane opens without a language server is counted (never
  // shown): which language to add next is a query on that table.
  noteLanguageGap(db, {
    tenantId,
    target: codeProjectTarget(tenantId, projectId),
    path: path.path,
    language,
  });

  const workspace = sandboxWorkspacesEnabled() ? await projectWorkspace(project) : null;
  if (workspace?.status === 'ready' && project.workspaceId) {
    const read = await sbWorkspaceRead(codeProjectTarget(tenantId, projectId), {
      id: project.workspaceId,
      path: path.path,
    });
    if (!read.ok) {
      const failure = clientFailure(read.err);
      if (failure.status === 415) {
        return NextResponse.json({
          path: path.path,
          text: '',
          binary: true,
          truncated: false,
          sizeBytes: 0,
          totalLines: 0,
          etag: '',
          language,
          source: 'checkout',
          editable: false,
        });
      }
      return jsonError(failure.status, 'read', failure.message);
    }
    return NextResponse.json({
      path: read.val.path,
      text: read.val.text,
      binary: false,
      truncated: false,
      sizeBytes: read.val.sizeBytes,
      totalLines: read.val.totalLines,
      etag: etagOf(read.val.text),
      language,
      source: 'checkout',
      editable: access.role !== 'viewer' && read.val.text.length <= WRITE_MAX_CHARS,
    });
  }

  const isGitHub = project.repo!.provider === GITHUB;
  const file = isGitHub
    ? await readGitHubSourceFile(
        await githubAuthFor(request, tenantId, session.subject),
        project.repo!.fullName,
        project.repo!.branch,
        path.path
      )
    : await readBitbucketSourceFile(
        await bitbucketAuthFor(request, tenantId, session.subject),
        project.repo!.fullName,
        project.repo!.branch,
        path.path
      );
  if (!file.ok) return jsonError(409, 'read', file.error);
  return NextResponse.json({
    path: path.path,
    text: file.text,
    binary: file.binary,
    truncated: file.truncated,
    sizeBytes: Buffer.byteLength(file.text, 'utf8'),
    totalLines: file.text ? file.text.split('\n').length : 0,
    etag: etagOf(file.text),
    language,
    source: isGitHub ? 'github' : 'bitbucket',
    branch: file.ref,
    editable: false,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId, { write: true });
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  if (!project.workspaceId)
    return jsonError(409, 'not-cloned', 'Clone the repository before adding files to it.');

  const path = validateWorkspacePath(new URL(request.url).searchParams.get('path'), {
    forWrite: true,
  });
  if (!path.ok || !path.path)
    return jsonError(400, 'invalid', path.ok ? 'Say where the file goes.' : path.message);
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > UPLOAD_MAX_BYTES) return jsonError(413, 'too-large', tooLarge());
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return jsonError(400, 'empty', 'The file is empty.');
  if (bytes.byteLength > UPLOAD_MAX_BYTES) return jsonError(413, 'too-large', tooLarge());

  const target = codeProjectTarget(tenantId, projectId);
  const fromEditor = request.headers.get('x-code-editor') === 'save';
  const ifMatch = request.headers.get('if-match');
  if (ifMatch !== null) {
    // The guard: the file as it is now must be the file as it was read.
    // A file that is gone or binary now is as much a change as new text.
    const current = await sbWorkspaceRead(target, { id: project.workspaceId, path: path.path });
    const etag = current.ok ? etagOf(current.val.text) : '';
    if (etag !== ifMatch.replace(/^"|"$/g, '')) {
      return NextResponse.json(
        {
          error: 'The file changed in the checkout since you opened it.',
          code: 'conflict',
          etag,
          text: current.ok ? current.val.text : null,
        },
        { status: 409 }
      );
    }
  }

  const written = await sbWorkspaceUpload(target, {
    id: project.workspaceId,
    path: path.path,
    bytes,
  });
  if (!written.ok) {
    const failure = clientFailure(written.err);
    return jsonError(failure.status, 'upload', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: fromEditor ? 'code.files.saved' : 'code.files.uploaded',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, path: written.val.path, sizeBytes: written.val.sizeBytes },
  });
  return NextResponse.json({
    file: { ...written.val, etag: etagOf(Buffer.from(bytes).toString('utf8')) },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId, { write: true });
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  if (!project.workspaceId)
    return jsonError(409, 'not-cloned', 'Clone the repository before creating files in it.');

  const body = await readJsonBody(request);
  const path = validateWorkspacePath(body.path, { forWrite: true });
  if (!path.ok || !path.path)
    return jsonError(400, 'invalid', path.ok ? 'Say where the file goes.' : path.message);

  const target = codeProjectTarget(tenantId, projectId);
  // Never silently overwrite — "New file" means new.
  const existing = await sbWorkspaceRead(target, { id: project.workspaceId, path: path.path });
  if (existing.ok) return jsonError(409, 'exists', `${path.path} already exists.`);

  const written = await sbWorkspaceWrite(target, {
    id: project.workspaceId,
    path: path.path,
    content: '',
  });
  if (!written.ok) {
    const failure = clientFailure(written.err);
    return jsonError(failure.status, 'create', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.files.created',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, path: written.val.path },
  });
  return NextResponse.json({ path: written.val.path, created: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId, { write: true });
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  if (!project.workspaceId)
    return jsonError(409, 'not-cloned', 'There is no checkout to remove files from.');

  const path = validateWorkspacePath(new URL(request.url).searchParams.get('path'), {
    forWrite: true,
  });
  if (!path.ok || !path.path)
    return jsonError(400, 'invalid', path.ok ? 'Say which file or folder to remove.' : path.message);

  const target = codeProjectTarget(tenantId, projectId);
  const removed = await sbWorkspaceRemove(target, { id: project.workspaceId, path: path.path });
  if (!removed.ok) {
    const failure = clientFailure(removed.err);
    return jsonError(failure.status, 'remove', failure.message);
  }
  if (!removed.val.deleted)
    return jsonError(404, 'not-found', `No such file or folder: ${path.path}`);
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.files.deleted',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, path: path.path },
  });
  return NextResponse.json({ path: path.path, deleted: true });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId, { write: true });
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  if (!project.workspaceId)
    return jsonError(409, 'not-cloned', 'There is no checkout to rename files in.');

  const body = await readJsonBody(request);
  const from = validateWorkspacePath(body.from, { forWrite: true });
  if (!from.ok || !from.path)
    return jsonError(400, 'invalid', from.ok ? 'Say which file or folder to rename.' : from.message);
  const to = validateWorkspacePath(body.to, { forWrite: true });
  if (!to.ok || !to.path)
    return jsonError(400, 'invalid', to.ok ? 'Say the new name or location.' : to.message);

  const target = codeProjectTarget(tenantId, projectId);
  const moved = await sbWorkspaceMove(target, {
    id: project.workspaceId,
    from: from.path,
    to: to.path,
  });
  if (!moved.ok) {
    const failure = clientFailure(moved.err);
    return jsonError(failure.status, 'move', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.files.renamed',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, from: from.path, to: to.path },
  });
  return NextResponse.json({ from: moved.val.from, to: moved.val.to });
}

function tooLarge(): string {
  return `Files are limited to ${Math.round(UPLOAD_MAX_BYTES / 1_048_576)} MB.`;
}
