/**
 * Who a model's removal would touch — operator-only. The roster asks this
 * before it removes a model, to offer a replacement for the people who
 * prefer it or whose projects, chats and agents are set to it. Counts
 * only: who they are stays here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { subjectsPreferringChatModel } from '@renkei/user-prefs';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { modelRemovedUses } from '@/lib/agents/model-removed-notification';

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
  return NextResponse.json({
    people: people.length,
    preferences: sum((person) => (person.preference ? 1 : 0)),
    projects: sum((person) => person.projects),
    chats: sum((person) => person.chats),
    agents: sum((person) => person.agents),
  });
}
