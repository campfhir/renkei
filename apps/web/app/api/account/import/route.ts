/**
 * Bringing chats and memories in from another assistant. The body is the
 * file itself — a ChatGPT, Claude or Takeout export zip, one of their
 * JSON files, Renkei's own export, or Markdown/text (pasted text comes as
 * a body too) — named by `?name=`. Read and parsed the same way twice:
 *
 *   ?mode=preview  answers what it found (ImportPreview), writes nothing
 *   ?mode=import   writes it (ImportOutcome), choosing with
 *                  `memories=1`, `chats=1`, `archive=1`
 *
 * The body is read with a running cap, so an oversized upload is refused
 * without being buffered. Memories are redacted as the memory route
 * redacts them. Everything lands in the signed-in person's own account.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOrgSettings } from '@renkei/settings';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { createOutboundRedactor } from '@/lib/chat/outbound-redaction';
import { parseImportFiles, previewOf } from '@/lib/data-portability/import-parse';
import { IMPORT_MAX_UPLOAD_BYTES, readUploadFiles } from '@/lib/data-portability/read-upload';
import { applyImport } from '@/lib/data-portability/apply-import';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';

export const maxDuration = 300;

const TOO_LARGE = `That file is larger than ${IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;

async function readBody(request: NextRequest): Promise<Uint8Array | 'too-large'> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > IMPORT_MAX_UPLOAD_BYTES) {
      await reader.cancel().catch(() => undefined);
      return 'too-large';
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const params = new URL(request.url).searchParams;
  const mode = params.get('mode');
  if (mode !== 'preview' && mode !== 'import') {
    return jsonError(400, 'invalid', 'Say whether to preview or import.');
  }
  const name = (params.get('name') ?? '').slice(0, 300);

  const body = await readBody(request);
  if (body === 'too-large') return jsonError(413, 'too-large', TOO_LARGE);
  const read = await readUploadFiles(name, body);
  if (!read.ok) {
    if (read.reason === 'too-large') {
      return jsonError(413, 'too-large', 'That zip unpacks to more than can be read at once.');
    }
    if (read.reason === 'empty') {
      return jsonError(400, 'empty', 'There is nothing to import in that.');
    }
    return jsonError(400, 'unreadable', 'That zip could not be opened.');
  }
  const plan = parseImportFiles(read.files);
  if (plan.memories.length === 0 && plan.chats.length === 0) {
    return jsonError(
      422,
      'nothing-found',
      plan.notes[0] ?? 'No chats or memories were found in that.'
    );
  }
  if (mode === 'preview') return NextResponse.json({ preview: previewOf(plan) });

  const choice = {
    memories: params.get('memories') === '1',
    chats: params.get('chats') === '1',
    archiveChats: params.get('archive') === '1',
  };
  if (!choice.memories && !choice.chats) {
    return jsonError(400, 'invalid', 'Choose memories, chats, or both.');
  }
  const settings = await getOrgSettings();
  const redactor = settings.ok ? createOutboundRedactor(settings.val) : null;
  const outcome = await applyImport(session.subject, plan, choice, (text) =>
    redactor ? redactor.apply(text).text : text
  );
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'user.data_imported',
    details: {
      sources: plan.sources,
      memories: outcome.memoriesAdded,
      chats: outcome.chatsAdded,
      messages: outcome.messagesAdded,
      stopped: outcome.stopped,
    },
  });
  if (outcome.stopped) {
    logger.warn('Import stopped early: {stopped}', {
      component: 'api/account/import',
      subject: session.subject,
      stopped: outcome.stopped,
      memories: outcome.memoriesAdded,
      chats: outcome.chatsAdded,
    });
  }
  return NextResponse.json({ imported: outcome, notes: plan.notes });
}
