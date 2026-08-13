/**
 * Markdown <-> Confluence page/blogpost/comment body.
 *
 * Confluence's v2 API accepts (and returns) the SAME Atlassian Document
 * Format Jira's REST v3 API uses for descriptions and comments — so this
 * reuses ../jira/markdown and ../jira/adf directly rather than maintaining
 * a second converter. ADF was chosen over Confluence's other body
 * representation, `storage` (an XHTML dialect with `ac:`/`ri:` macro
 * namespaces), because it's the better-specified schema and doesn't
 * require hand-rolling macro markup to get a Markdown document to render
 * correctly.
 *
 * The one real difference: Jira's REST v3 embeds the ADF document as a
 * nested JSON object; Confluence's `body.atlas_doc_format.value` wants it
 * as a JSON *string*. That's the only thing this module adds.
 */

import { markdownToAdf, isBlankMarkdown } from '../jira/markdown';
import { adfToMarkdown } from '../jira/adf';
import { rec } from './client';

export { isBlankMarkdown };

export interface ConfluenceBody {
  representation: 'atlas_doc_format';
  value: string;
}

/** Markdown -> the body payload Confluence's create/update page & comment APIs expect. */
export function markdownToConfluenceBody(markdown: string): ConfluenceBody {
  return { representation: 'atlas_doc_format', value: JSON.stringify(markdownToAdf(markdown)) };
}

/**
 * A Confluence resource's `body` field (requested with
 * `body-format=atlas_doc_format`) -> Markdown. Confluence nests the ADF
 * document's JSON string under `body.atlas_doc_format.value`; anything
 * else (a different representation was returned, or the field is absent)
 * renders as empty rather than throwing — same fail-safe posture as
 * adfToMarkdown itself.
 */
export function confluenceBodyToMarkdown(body: unknown): string {
  const value = rec(rec(body).atlas_doc_format).value;
  if (typeof value !== 'string' || !value) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return '';
  }
  return adfToMarkdown(parsed);
}
