/**
 * The same route as the project's own (`/notebook/kernel`), reached
 * through a chat: the notebook's kernel runs in the chat's worktree
 * rather than the project's base clone. The handler reads `chatId` from
 * the path.
 */
export { GET, POST } from '../../../../notebook/kernel/route';
