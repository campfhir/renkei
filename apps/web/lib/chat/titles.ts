/**
 * A chat's title is its first message, trimmed to a sidebar line. No
 * model call: a title that appears the instant the chat exists beats a
 * better one that appears after the first reply.
 */

export const TITLE_MAX_CHARS = 60;

export function deriveTitle(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return 'New chat';
  const collapsed = firstLine.replace(/\s+/g, ' ');
  if (collapsed.length <= TITLE_MAX_CHARS) return collapsed;
  const cut = collapsed.slice(0, TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > TITLE_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
