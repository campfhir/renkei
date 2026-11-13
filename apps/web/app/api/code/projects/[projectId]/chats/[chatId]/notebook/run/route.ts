/**
 * The same route as the project's own (`/notebook/run`), reached through
 * a chat: the notebook runs in the chat's worktree rather than the
 * project's base clone. The handler reads `chatId` from the path.
 */
export { POST } from '../../../../notebook/run/route';
