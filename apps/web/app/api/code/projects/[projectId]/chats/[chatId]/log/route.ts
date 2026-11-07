/**
 * The same route as the project's own (`/log`), reached through a chat:
 * the chat's worktree is the checkout it reads, rather than the
 * project's base clone. The handler reads `chatId` from the path.
 */
export { GET } from '../../../log/route';
