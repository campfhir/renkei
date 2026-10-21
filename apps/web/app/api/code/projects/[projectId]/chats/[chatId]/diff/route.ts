/**
 * The same route as the project's own (`/diff`), reached through a chat:
 * the chat's worktree is the checkout it works in, rather than the
 * project's base clone. The handler reads `chatId` from the path.
 */
export { GET } from '../../../diff/route';
