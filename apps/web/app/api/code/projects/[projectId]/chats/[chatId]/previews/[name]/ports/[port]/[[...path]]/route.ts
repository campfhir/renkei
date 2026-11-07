/**
 * The same relay as the project's own (`/previews/[name]/ports/[port]/…`),
 * reached through a chat. The handler reads `chatId` from the path.
 */
export {
  GET,
  HEAD,
  POST,
  PUT,
  PATCH,
  DELETE,
  OPTIONS,
} from '../../../../../../../previews/[name]/ports/[port]/[[...path]]/route';
