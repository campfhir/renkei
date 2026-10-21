/**
 * The API base for a code project's checkout routes. With a chat they are
 * the chat's own — its worktree is the checkout it works in
 * (`…/chats/[chatId]/files`, `/diff`, `/commit` and the rest); without
 * one, the project's base clone. Environment, pull requests and the rest
 * of the project's state stay at the project's own address.
 */
export function codeProjectUrl(projectId: string, chatId?: string | null): string {
  return `/api/code/projects/${projectId}${chatId ? `/chats/${chatId}` : ''}`;
}
