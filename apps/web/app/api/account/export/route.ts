/**
 * Everything of yours, as a zip: preferences, memory, the projects you
 * own and every chat you own with all its messages — JSON to read back,
 * Markdown to read — plus the portable profile (export-bundle.ts lists the
 * files). Only ever the signed-in person's own data; nobody can export
 * someone else's.
 */

import type { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { chatRequestContext } from '@/lib/chat/route-support';
import { collectExportData } from '@/lib/data-portability/collect';
import { exportFileName, exportFiles } from '@/lib/data-portability/export-bundle';
import { attachmentDisposition } from '@/lib/data-portability/http';
import { recordAuditEvent } from '@/lib/audit-events';
import { isDownloadPrefetch } from '@/lib/download-prefetch';

export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const data = await collectExportData(session.subject, new Date());
  const zip = new JSZip();
  for (const file of exportFiles(data)) zip.file(file.path, file.content);
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  // A fetch ahead of a tap (the share sheet in a home-screen app) is audited
  // as what it is: the export left the server and reached this person's
  // device, and whether they kept it is not known until the tap's POST
  // below. A plain download is the export itself.
  recordAuditEvent({
    actorSubject: session.subject,
    action: isDownloadPrefetch(request) ? 'user.data_export_prepared' : 'user.data_exported',
    details: {
      format: 'zip',
      chats: data.chats.length,
      memoryEntries: data.memory.entries.length,
      projects: data.projects.length,
    },
  });
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': attachmentDisposition(exportFileName(data.exportedAt)),
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
    },
  });
}

/** The tap that took an export fetched ahead of it (lib/download-prefetch.ts): the audit event, nothing else. */
export async function POST(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  recordAuditEvent({
    actorSubject: ready.context.session.subject,
    action: 'user.data_exported',
    details: { format: 'zip', via: 'share-sheet' },
  });
  return new Response(null, { status: 204 });
}
