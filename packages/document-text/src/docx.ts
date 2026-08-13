/**
 * Word (.docx) text.
 *
 * The interesting part of this file is what it SKIPS. Naive extractors that
 * take every `w:t` produce text that is subtly wrong in ways nobody notices
 * until it is in a search index:
 *
 *   w:del       deleted revision text. Emitting it indexes sentences the
 *               author explicitly removed — a correctness problem and a
 *               governance one.
 *   mc:Fallback the compatibility twin of mc:Choice. Process both and every
 *               affected run appears TWICE. This is the most common silent
 *               bug in hand-rolled docx extraction.
 *   w:instrText field codes (MERGEFIELD, HYPERLINK "…", PAGE) — markup, not
 *               prose.
 *   headers/footers  per-page boilerplate: company name, confidentiality
 *               notice, page number. One copy adds nothing retrievable and
 *               per-page copies would pollute every chunk.
 *
 * Tracked INSERTIONS (w:ins) are kept: that is the current text.
 */

import { scanXml, attribute } from './xml';
import { TextBudget } from './types';

/** The parts worth reading. Media, embeddings and styles are never inflated. */
export const DOCX_PARTS = /^(word\/document\.xml|word\/(foot|end)notes\.xml|docProps\/core\.xml)$/;

/** Subtrees whose entire contents are dropped. */
const SKIP_SUBTREES = new Set(['w:del', 'mc:Fallback', 'w:instrText', 'w:proofErr']);

/** Read `dc:title` so a file named Document1.docx still has a real name. */
function titleOf(coreXml: string | undefined): string {
  if (!coreXml) return '';
  let inTitle = false;
  let title = '';
  scanXml(coreXml, {
    onOpen: (tag) => {
      if (tag.name === 'dc:title') inTitle = true;
    },
    onClose: (name) => {
      if (name === 'dc:title') inTitle = false;
    },
    onText: (text) => {
      if (inTitle) title += text;
    },
  });
  return title.trim();
}

function extractBody(xml: string, budget: TextBudget): void {
  // Depth counter rather than a boolean: w:del can nest inside w:ins, and a
  // boolean would re-enable output at the inner close tag.
  let skipDepth = 0;
  let preserveSpace = false;
  let inText = false;

  scanXml(xml, {
    onOpen: (tag) => {
      if (SKIP_SUBTREES.has(tag.name)) {
        if (!tag.selfClosing) skipDepth += 1;
        return;
      }
      if (skipDepth > 0) return;

      switch (tag.name) {
        case 'w:t':
          inText = true;
          preserveSpace = attribute(tag.attributes, 'xml:space') === 'preserve';
          break;
        case 'w:tab':
          budget.push('\t');
          break;
        case 'w:br':
        case 'w:cr':
          budget.push('\n');
          break;
        case 'w:tbl':
          budget.push('\n');
          break;
        default:
          break;
      }
    },
    onClose: (name) => {
      if (SKIP_SUBTREES.has(name)) {
        if (skipDepth > 0) skipDepth -= 1;
        return;
      }
      if (skipDepth > 0) return;

      switch (name) {
        case 'w:t':
          inText = false;
          preserveSpace = false;
          break;
        case 'w:p':
          budget.push('\n');
          break;
        case 'w:tc':
          budget.push(' | ');
          break;
        case 'w:tr':
          budget.push('\n');
          break;
        case 'w:tbl':
          budget.push('\n');
          break;
        default:
          break;
      }
    },
    onText: (text) => {
      if (skipDepth > 0 || !inText) return;
      // Without honouring xml:space, leading and trailing spaces vanish and
      // adjacent runs fuse into onewordlikethis.
      budget.push(preserveSpace ? text : text.replace(/^\s+|\s+$/g, (m) => (m ? ' ' : '')));
    },
  });
}

export function extractDocx(parts: Map<string, Uint8Array>, budget: TextBudget): void {
  const decoder = new TextDecoder('utf-8');
  const read = (name: string): string | undefined => {
    const bytes = parts.get(name);
    return bytes ? decoder.decode(bytes) : undefined;
  };

  const title = titleOf(read('docProps/core.xml'));
  if (title) budget.push(`${title}\n\n`);

  const document = read('word/document.xml');
  if (document) extractBody(document, budget);

  // Footnotes and endnotes carry real prose often absent from the body.
  for (const name of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const xml = read(name);
    if (!xml || budget.spent) continue;
    budget.push('\n');
    extractBody(xml, budget);
  }
}
