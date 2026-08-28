/**
 * Import an agent from an exported markdown document.
 *
 * The document's `json renkei-agent` block carries the exact definition
 * (see lib/agents/export-markdown.ts); this route extracts it and runs the
 * SAME parse → validate → save path the builder and agent_create use — so
 * an import can never smuggle anything a hand-built save could not, and a
 * stale-format export comes back as a current-format agent because the
 * normalizer stamps every save.
 *
 * Always created DISABLED and under a name made unique when the exported
 * one is taken (names are tenant-unique): imports are review-first, same
 * as agent_create.
 */

import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getDatabase } from '@renkei/db';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { extractAgentDefinition } from '@/lib/agents/import-markdown';
import { parseAgentPayload } from '@/lib/agents/payload';
import { saveAgent } from '@/lib/agents/save';

/** The exported name, or the first "(imported)"-suffixed variant free. */
async function availableName(db: Kysely<DB>, tenantId: string, wanted: string): Promise<string> {
  const base = wanted.trim().slice(0, 180) || 'Imported agent';
  const rows = await db
    .selectFrom('agents')
    .select('name')
    .where('tenant_id', '=', tenantId)
    .where('name', 'like', `${base}%`)
    .execute();
  const taken = new Set(rows.map((row) => row.name));
  if (!taken.has(base)) return base;
  if (!taken.has(`${base} (imported)`)) return `${base} (imported)`;
  let suffix = 2;
  while (taken.has(`${base} (imported ${suffix})`)) suffix += 1;
  return `${base} (imported ${suffix})`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const body: unknown = await request.json().catch(() => null);
  const payload: { markdown?: unknown } =
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {};
  const markdown = payload.markdown;
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return NextResponse.json({ error: 'Paste the exported markdown document.' }, { status: 400 });
  }

  const extracted = extractAgentDefinition(markdown);
  if (!extracted.ok) return NextResponse.json({ error: extracted.error }, { status: 400 });
  const definition = extracted.definition;

  const name = await availableName(
    db,
    tenantId,
    typeof definition.name === 'string' ? definition.name : 'Imported agent'
  );
  const parsed = parseAgentPayload({
    name,
    steps: definition.steps,
    triggers: Array.isArray(definition.triggers) ? definition.triggers : [],
    // Review-first, like agent_create: the builder is the consent surface
    // for arming an agent.
    enabled: false,
    llmModelId: null,
    guardrails: typeof definition.guardrails === 'string' ? definition.guardrails : null,
    blockedTools: Array.isArray(definition.blockedTools) ? definition.blockedTools : [],
  });
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const result = await saveAgent(db, tenantId, session.subject, parsed, { defer: after });
  if (result.outcome === 'invalid') {
    return NextResponse.json({ error: 'The definition does not validate.', issues: result.issues }, { status: 422 });
  }
  if (result.outcome !== 'saved') {
    return NextResponse.json({ error: 'Could not import the agent.' }, { status: 500 });
  }
  return NextResponse.json(
    { agentId: result.agentId, name, apiKeys: result.apiKeys },
    { status: 201 }
  );
}
