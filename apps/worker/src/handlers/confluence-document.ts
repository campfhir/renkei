/**
 * A Confluence page, flattened into the document that gets embedded.
 *
 * What this replaces walked the ADF tree collecting text nodes and joined them
 * with spaces, so a page came out as one unbroken line: "Runbook Restart the
 * worker first. Rollback Revert the image". Every heading, paragraph break and
 * bullet was gone. That is bad for a reader, and worse for chunking — the
 * splitter had no paragraph boundaries to cut on, so chunks landed mid-sentence
 * and a retrieved fragment could start halfway through a step.
 *
 * The old function said the rich converter "lives in the web app and is not
 * importable here", which was true and was the whole reason for the shortcut.
 * It moved into @renkei/connector-atlassian when the Jira sweep needed it, so
 * the trade it described no longer exists.
 *
 * Structure, matching the Jira document so the knowledge page renders both the
 * same way:
 *
 *   # <title>
 *   <body as markdown, its own headings pushed one level down>
 *
 * The shift is what keeps a page that opens with its own `# Overview` from
 * sitting level with the page title above it.
 */

import { adfToMarkdown, demoteHeadings } from '@renkei/connector-atlassian';

/** The title is a level-1 heading, so the body starts at level 2. */
const DEMOTE_IN_BODY = 1;

/** Whole-document ceiling, before chunking. Confluence pages can be long. */
const MAX_DOCUMENT_CHARS = 60_000;

export function confluenceDocument(title: string, adfJson: string): string {
  const heading = title.trim();

  let parsed: unknown = null;
  if (adfJson) {
    try {
      parsed = JSON.parse(adfJson);
    } catch {
      // A body we cannot parse is not a reason to drop the page: its title is
      // still worth finding.
      parsed = null;
    }
  }

  const body = parsed === null ? '' : adfToMarkdown(parsed).trim();
  // Only demote when there IS a title above the body to nest under.
  const nested = heading ? demoteHeadings(body, DEMOTE_IN_BODY) : body;

  const document = [heading ? `# ${heading}` : '', nested].filter(Boolean).join('\n\n').trim();
  return document.length > MAX_DOCUMENT_CHARS
    ? `${document.slice(0, MAX_DOCUMENT_CHARS)}…`
    : document;
}
