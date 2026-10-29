/**
 * The lines every chat route starts with, once: the session and a JSON
 * error shape the client helpers understand. Routes read through the data
 * store (`getDataStore()`).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getSessionFromRequest, type Session } from '@/lib/session';
import type { ReadBytesError } from './attachments';

export interface ChatRequestContext {
  session: Session;
}

export function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

export async function chatRequestContext(
  request: NextRequest
): Promise<{ ok: true; context: ChatRequestContext } | { ok: false; response: NextResponse }> {
  const session = await getSessionFromRequest(request);
  if (!session) return { ok: false, response: jsonError(401, 'unauthenticated', 'Not signed in') };
  return {
    ok: true,
    context: { session },
  };
}

export async function readJsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  const raw: unknown = await request.json().catch(() => null);
  const body: Record<string, unknown> = {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) body[key] = value;
  }
  return body;
}

export function optionalString(value: unknown, maxChars: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.slice(0, maxChars);
}

/** Why the bytes could not be served, as the download, preview and copy routes all say it. */
export function readBytesError(error: ReadBytesError): Response {
  switch (error) {
    case 'UNCONFIGURED':
      return jsonError(503, 'uploads-off', 'The file store is not configured.');
    case 'NOT_FOUND':
      return jsonError(404, 'store', 'The file is unavailable.');
    case 'CONTENT_KEY':
      return jsonError(
        409,
        'content-key',
        'The file is sealed under a key this session cannot open. Sign in again.'
      );
    default:
      return jsonError(502, 'store', 'The file is unavailable.');
  }
}
