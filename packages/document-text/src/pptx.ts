/**
 * PowerPoint (.pptx) text.
 *
 * Two things here are easy to get wrong and hard to notice:
 *
 * 1. SLIDE ORDER comes from presentation.xml's `p:sldIdLst` resolved through
 *    the relationships — not from filenames. Filename numbering reflects
 *    creation order and diverges the moment anyone reorders a deck, and
 *    sorting `slide10.xml` lexicographically puts it before `slide2.xml`.
 *
 * 2. SPEAKER NOTES are usually the most valuable text in the file. Slide
 *    bodies are fragments ("Q4 revenue", "Next steps"); the notes are where
 *    someone wrote prose. They are reached per-slide through that slide's own
 *    relationships — `notesSlideN` does NOT reliably correspond to `slideN`
 *    when only some slides carry notes.
 *
 * Layouts and masters are skipped deliberately: they hold "Click to edit
 * Master title style", and extracting them would have every deck in the
 * tenant contribute the same placeholder text to the index.
 */

import { scanXml, attribute } from './xml';
import { TextBudget } from './types';

export const PPTX_PARTS =
  /^(ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|ppt\/slides\/slide\d+\.xml|ppt\/slides\/_rels\/slide\d+\.xml\.rels|ppt\/notesSlides\/notesSlide\d+\.xml)$/;

/** Slide relationship ids in presentation order. */
function readSlideOrder(xml: string | undefined): string[] {
  if (!xml) return [];
  const ids: string[] = [];
  scanXml(xml, {
    onOpen: (tag) => {
      if (tag.name !== 'p:sldId') return;
      const id = attribute(tag.attributes, 'r:id');
      if (id) ids.push(id);
    },
  });
  return ids;
}

function readRelationships(xml: string | undefined, base: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  scanXml(xml, {
    onOpen: (tag) => {
      if (tag.name !== 'Relationship') return;
      const id = attribute(tag.attributes, 'Id');
      const target = attribute(tag.attributes, 'Target');
      if (!id || !target) return;
      // Targets are relative to the part's folder: "../notesSlides/x.xml".
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : new URL(target, `file:///${base}/`).pathname.slice(1);
      map.set(id, resolved);
    },
  });
  return map;
}

/** All `a:t` text in document order, with paragraph and line breaks honoured. */
function readShapeText(xml: string, budget: TextBudget): void {
  let inText = false;

  scanXml(xml, {
    onOpen: (tag) => {
      switch (tag.name) {
        case 'a:t':
          inText = true;
          break;
        case 'a:br':
          budget.push('\n');
          break;
        default:
          break;
      }
    },
    onClose: (name) => {
      switch (name) {
        case 'a:t':
          inText = false;
          break;
        case 'a:p':
          budget.push('\n');
          break;
        case 'a:tc':
          budget.push(' | ');
          break;
        case 'a:tr':
          budget.push('\n');
          break;
        default:
          break;
      }
    },
    onText: (text) => {
      if (inText) budget.push(text);
    },
  });
}

export function extractPptx(parts: Map<string, Uint8Array>, budget: TextBudget): number {
  const decoder = new TextDecoder('utf-8');
  const read = (name: string): string | undefined => {
    const bytes = parts.get(name);
    return bytes ? decoder.decode(bytes) : undefined;
  };

  const order = readSlideOrder(read('ppt/presentation.xml'));
  const presentationRels = readRelationships(read('ppt/_rels/presentation.xml.rels'), 'ppt');

  // Fall back to filename order only when the relationship graph is missing —
  // a malformed deck should still yield text, just possibly out of order.
  const slideParts =
    order.length > 0
      ? order.map((id) => presentationRels.get(id)).filter((name): name is string => Boolean(name))
      : [...parts.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();

  let slideNumber = 0;
  for (const slidePart of slideParts) {
    if (budget.spent) break;
    const xml = read(slidePart);
    if (!xml) continue;

    slideNumber += 1;
    budget.push(`\n## Slide ${slideNumber}\n\n`);
    readShapeText(xml, budget);

    const file = slidePart.slice(slidePart.lastIndexOf('/') + 1);
    const relsPart = `ppt/slides/_rels/${file}.rels`;
    const slideRels = readRelationships(read(relsPart), 'ppt/slides');
    const notesPart = [...slideRels.values()].find((name) => name.includes('notesSlides/'));
    const notesXml = notesPart ? read(notesPart) : undefined;
    if (notesXml && !budget.spent) {
      budget.push('\nNotes: ');
      readShapeText(notesXml, budget);
    }
  }

  return slideNumber;
}
