/**
 * Which kind of chat session a chat is, for the person's lists
 * (permission-prefs.ts) and the tool rules (tool-decision.ts): a code
 * project's chat, a chat project's chat, or an ordinary chat.
 */

import { getProjectRow, type ProjectRow } from './projects';
import type { ChatSessionKind } from './permission-rules';

export function sessionKindOf(project: Pick<ProjectRow, 'kind'> | null): ChatSessionKind {
  if (!project) return 'chat';
  return project.kind === 'code' ? 'code' : 'project';
}

/** A chat's kind and its project, read once. */
export async function chatSession(chat: {
  projectId: string | null;
}): Promise<{ kind: ChatSessionKind; project: ProjectRow | null }> {
  const project = chat.projectId ? await getProjectRow(chat.projectId) : null;
  return { kind: sessionKindOf(project), project };
}
