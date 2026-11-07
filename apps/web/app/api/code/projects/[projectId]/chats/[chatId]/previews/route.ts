/**
 * The same route as the project's own (`/previews`), reached through a
 * chat: the chat's worktree is the checkout a preview runs in, rather
 * than the project's base clone. The handler reads `chatId` from the path.
 */
export { GET, POST } from '../../../previews/route';
