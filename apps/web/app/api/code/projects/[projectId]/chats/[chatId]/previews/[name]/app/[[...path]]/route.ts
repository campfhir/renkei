/**
 * The same relay as the project's own (`/previews/[name]/app/…`),
 * reached through a chat, so the address a chat answers with is one of
 * its own. The handler reads `chatId` from the path.
 */
export {
  GET,
  HEAD,
  POST,
  PUT,
  PATCH,
  DELETE,
  OPTIONS,
} from '../../../../../../previews/[name]/app/[[...path]]/route';
