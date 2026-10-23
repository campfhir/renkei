/**
 * A chat's title starts as its first message, trimmed to a sidebar line, so
 * it appears the instant the chat exists. The model then gives the chat one
 * better title beside the first reply (chat-title-tools.ts), and can rename it
 * later on the person's word.
 */

export const TITLE_MAX_CHARS = 60;

/** The tool the model renames a chat with (chat-title-tools.ts); named here so client code can label it. */
export const CHAT_RENAME_TOOL = 'chat_rename';

function firstLineOf(text: string): string | null {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? firstLine.replace(/\s+/g, ' ') : null;
}

function fitTitle(collapsed: string): string {
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed;
  const cut = collapsed.slice(0, TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > TITLE_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function deriveTitle(text: string): string {
  const collapsed = firstLineOf(text);
  return collapsed ? fitTitle(collapsed) : 'New chat';
}

/**
 * A title the model or the person wrote on purpose: the first line, with
 * any quotes it was wrapped in taken off, cut to the sidebar's length. Null
 * when nothing is left to show.
 */
export function cleanTitle(text: string): string | null {
  const collapsed = firstLineOf(text)
    ?.replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
  return collapsed ? fitTitle(collapsed) : null;
}
