/**
 * The sandbox scratch space a chat's tools stage in (migration 169). A
 * code project's chats share one — they work in one checkout, and the
 * project page shows them side by side — so a file staged in one is there
 * for the next; any other chat has its own. Nothing staged from one chat
 * or project is listed, read or brought back from another.
 */
export function sandboxScopeOf(
  chat: { id: string },
  project: { id: string; kind: string } | null
): string {
  return project?.kind === 'code' ? `project:${project.id}` : `chat:${chat.id}`;
}
