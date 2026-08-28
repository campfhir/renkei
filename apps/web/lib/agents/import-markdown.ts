/**
 * The read half of the markdown round trip.
 *
 * An exported agent document ends with a fenced block tagged
 * `json renkei-agent` carrying the exact stored definition (see
 * export-markdown.ts). Import means extracting that block — everything
 * else in the document is projection for people and models, deliberately
 * lossy (onSuccess and exhausted never appear in a prompt; trigger lines
 * are summaries) — and feeding it through the SAME parse/validate/save
 * path every other create uses. Markdown WITHOUT the block is prose, and
 * prose is the drafting pipeline's job (agent_draft), not a parser's.
 */

const DEFINITION_FENCE = /^```json renkei-agent[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

export function extractAgentDefinition(
  markdown: string
): { ok: true; definition: Record<string, unknown> } | { ok: false; error: string } {
  const matches = [...markdown.matchAll(DEFINITION_FENCE)];
  if (matches.length === 0) {
    return {
      ok: false,
      error:
        'No definition block found. Import takes a document exported by "Copy as Markdown" — ' +
        'it ends with a ```json renkei-agent fenced block. For plain prose, draft a new ' +
        'agent from the description instead.',
    };
  }
  // The LAST block wins: the exporter writes exactly one, at the end, and
  // anything earlier matching the fence could only be quoted material.
  const raw = matches[matches.length - 1][1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `The definition block is not valid JSON: ${
        error instanceof Error ? error.message : 'syntax error'
      }`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'The definition block must be a JSON object.' };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowed to a plain object above
  return { ok: true, definition: parsed as Record<string, unknown> };
}
