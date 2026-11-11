/**
 * Who a model's removal would touch — operator-only. The roster asks this
 * before it removes a model, to offer a replacement for the people who
 * prefer it or whose projects, chats and agents are set to it. Counts,
 * and the names of at most three of them: a model can have hundreds of
 * people on it, and the dialog needs to say who only when it is a few.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { subjectsPreferringChatModel } from '@renkei/user-prefs';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { modelRemovedUses } from '@/lib/agents/model-removed-notification';

/** How many of the people on a model the dialog names; the rest are counted. */
const NAMED_PEOPLE = 3;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
): Promise<NextResponse> {
  const { modelId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const models = getDataStore().llmModels;
  if (!(await models.get(modelId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const people = modelRemovedUses(
    await models.usedBy(modelId),
    await subjectsPreferringChatModel(modelId)
  );
  const sum = (of: (person: (typeof people)[number]) => number) =>
    people.reduce((total, person) => total + of(person), 0);
  // The first few by subject; someone the identity table does not know goes unnamed.
  const named = people.slice(0, NAMED_PEOPLE).map((person) => person.subject);
  const identities = named.length > 0 ? await getDataStore().identities.listBySubjects(named) : [];
  const nameOf = new Map(identities.map((row) => [row.subject, row.displayName || row.email]));
  return NextResponse.json({
    people: people.length,
    names: named.flatMap((subject) => nameOf.get(subject) || []),
    preferences: sum((person) => (person.preference ? 1 : 0)),
    projects: sum((person) => person.projects),
    chats: sum((person) => person.chats),
    agents: sum((person) => person.agents),
  });
}
