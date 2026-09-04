import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  chatRequestContext,
  jsonError,
  optionalString,
  readJsonBody,
} from '@/lib/chat/route-support';
import { createLibrary, listAccessibleLibraries, LIBRARY_NAME_MAX_CHARS } from '@/lib/chat/prompts';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const libraries = await listAccessibleLibraries(db, tenantId, session.subject);
  return NextResponse.json({
    libraries: libraries.map(({ library, role }) => ({
      id: library.id,
      name: library.name,
      description: library.description,
      publishedToOrg: library.publishedToOrg,
      role,
      updatedAt: library.updatedAt.toISOString(),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const name = optionalString(body.name, LIBRARY_NAME_MAX_CHARS);
  if (!name) return jsonError(400, 'invalid', 'Give the library a name');
  const description = optionalString(body.description, 2_000) ?? null;
  const libraryId = await createLibrary(db, {
    tenantId,
    ownerSubject: session.subject,
    name,
    description: description || null,
  });
  return NextResponse.json({ libraryId }, { status: 201 });
}
