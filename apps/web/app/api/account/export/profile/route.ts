/**
 * The portable profile (profile-markdown.ts): what your assistant knows
 * about you, the projects you own and what you have recently asked about,
 * as one Markdown file to give ChatGPT, Claude, Gemini or any other
 * assistant. The signed-in person's own, only.
 */

import type { NextRequest } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { collectExportData } from '@/lib/data-portability/collect';
import { renderProfileMarkdown } from '@/lib/data-portability/profile-markdown';
import { attachmentDisposition } from '@/lib/data-portability/http';
import { recordAuditEvent } from '@/lib/audit-events';
import { isDownloadPrefetch } from '@/lib/download-prefetch';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const data = await collectExportData(session.subject, new Date());
  const text = renderProfileMarkdown(data);
  if (isDownloadPrefetch(request)) {
    // Fetched ahead of a tap for the share sheet: the tap's POST below is the export.
    logger.info(
      '{actor} opened a page that prepared their profile export; nothing was audited yet',
      { component: 'api/account/export/profile', ...who(session), format: 'profile' }
    );
  } else {
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'user.data_exported',
      details: { format: 'profile', memoryEntries: data.memory.entries.length },
    });
  }
  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': attachmentDisposition(
        `renkei-profile-${data.exportedAt.slice(0, 10)}.md`
      ),
      'cache-control': 'no-store',
    },
  });
}

/** The tap that took a profile fetched ahead of it (lib/download-prefetch.ts): the audit event, nothing else. */
export async function POST(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  recordAuditEvent({
    actorSubject: ready.context.session.subject,
    action: 'user.data_exported',
    details: { format: 'profile', via: 'share-sheet' },
  });
  return new Response(null, { status: 204 });
}
