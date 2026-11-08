import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  chatRequestContext,
  jsonError,
  optionalString,
  readJsonBody,
} from '@/lib/chat/route-support';
import {
  createLibrary,
  listAccessibleLibraries,
  parseLibraryScope,
  LIBRARY_NAME_MAX_CHARS,
} from '@/lib/chat/prompts';

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const libraries = await listAccessibleLibraries(session.subject);
  return NextResponse.json({
    libraries: libraries.map(({ library, role }) => ({
      id: library.id,
      name: library.name,
      description: library.description,
      scope: library.scope,
      role,
      updatedAt: library.updatedAt.toISOString(),
    })),
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const body = await readJsonBody(request);
  const name = optionalString(body.name, LIBRARY_NAME_MAX_CHARS);
  if (!name) return jsonError(400, 'invalid', 'Give the library a name');
  const description = optionalString(body.description, 2_000) ?? null;
  const scope = parseLibraryScope(body.scope);
  if (scope === null) return jsonError(400, 'invalid', 'Scope must be "any" or "code"');
  const libraryId = await createLibrary({
    ownerSubject: session.subject,
    name,
    description: description || null,
    ...(scope ? { scope } : {}),
  });
  return NextResponse.json({ libraryId }, { status: 201 });
}
