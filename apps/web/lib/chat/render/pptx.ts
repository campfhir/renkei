/**
 * Blocks → a slide deck, with pptxgenjs. Markdown has no slides, so the
 * rule is the one people already use in outlines: every level-1 or
 * level-2 heading starts a slide titled by it; what follows until the
 * next such heading is that slide's body. A leading level-1 heading
 * whose body is nothing but a paragraph or two becomes a title slide.
 * Bullets keep their nesting, a table becomes a slide table, code goes
 * in a monospace box, and body text shrinks to fit rather than overflow.
 * With no headings at all, one slide carries everything.
 */

import PptxGenJS from 'pptxgenjs';
import { plainText, type Block, type Inline, type ListItem } from './markdown-blocks';

type Pptx = InstanceType<typeof PptxGenJS>;
type TextProps = PptxGenJS.TextProps;

const SLIDE = { width: 10, height: 5.625 };
const MARGIN = 0.5;
const TITLE_HEIGHT = 0.9;
const BODY_TOP = MARGIN + TITLE_HEIGHT + 0.1;
const BODY_HEIGHT = SLIDE.height - BODY_TOP - MARGIN;
const BODY_WIDTH = SLIDE.width - MARGIN * 2;
const FONT = 'Calibri';
const CODE_FONT = 'Consolas';
const DARK = '1F1F1F';
const ACCENT = '2F5597';

interface Slide {
  title: Inline[] | null;
  body: Block[];
}

export function splitSlides(blocks: Block[]): Slide[] {
  const slides: Slide[] = [];
  let current: Slide | null = null;
  for (const block of blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      current = { title: block.inlines, body: [] };
      slides.push(current);
    } else {
      if (!current) {
        current = { title: null, body: [] };
        slides.push(current);
      }
      current.body.push(block);
    }
  }
  return slides;
}

function runsOf(inlines: Inline[], base: TextProps['options'] = {}): TextProps[] {
  return inlines.map((inline) => ({
    text: inline.text,
    options: {
      ...base,
      bold: inline.bold || base?.bold,
      italic: inline.italic,
      strike: inline.strike ? ('sngStrike' as const) : undefined,
      ...(inline.code ? { fontFace: CODE_FONT } : {}),
      ...(inline.href ? { hyperlink: { url: inline.href }, color: ACCENT } : {}),
    },
  }));
}

function listRuns(items: ListItem[], ordered: boolean, level: number, out: TextProps[]): void {
  for (const item of items) {
    const runs = runsOf(item.inlines);
    runs.forEach((run, index) => {
      run.options = {
        ...run.options,
        ...(index === 0
          ? { bullet: ordered ? { type: 'number' as const } : true, indentLevel: level }
          : {}),
        breakLine: index === runs.length - 1,
      };
    });
    out.push(...runs);
    for (const child of item.children) {
      if (child.type === 'list') listRuns(child.items, child.ordered, level + 1, out);
      else if (child.type === 'paragraph') {
        const inner = runsOf(child.inlines);
        inner.forEach((run, index) => {
          run.options = {
            ...run.options,
            indentLevel: level + 1,
            breakLine: index === inner.length - 1,
          };
        });
        out.push(...inner);
      }
    }
  }
}

/** Body blocks → the text runs of one text box, with slide-level lines broken. */
function bodyRuns(blocks: Block[]): TextProps[] {
  const out: TextProps[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const runs = runsOf(block.inlines, { bold: true, color: ACCENT });
        runs.forEach((run, index) => {
          run.options = {
            ...run.options,
            breakLine: index === runs.length - 1,
            paraSpaceBefore: 6,
          };
        });
        out.push(...runs);
        break;
      }
      case 'paragraph': {
        const runs = runsOf(block.inlines);
        runs.forEach((run, index) => {
          run.options = { ...run.options, breakLine: index === runs.length - 1, paraSpaceAfter: 6 };
        });
        out.push(...runs);
        break;
      }
      case 'list':
        listRuns(block.items, block.ordered, 0, out);
        break;
      case 'code':
        out.push({
          text: block.text,
          options: { fontFace: CODE_FONT, fontSize: 12, breakLine: true, paraSpaceAfter: 6 },
        });
        break;
      case 'quote':
        out.push(
          ...bodyRuns(block.blocks).map((run) => ({
            ...run,
            options: { ...run.options, italic: true, indentLevel: 1 },
          }))
        );
        break;
      case 'rule':
        out.push({ text: '', options: { breakLine: true } });
        break;
      case 'table':
        // Tables get their own box; see addSlide.
        break;
    }
  }
  return out;
}

function tableRows(block: Extract<Block, { type: 'table' }>): PptxGenJS.TableRow[] {
  const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
  const cell = (
    inlines: Inline[] | undefined,
    header: boolean,
    index: number
  ): PptxGenJS.TableCell => ({
    text: plainText(inlines ?? []),
    options: {
      bold: header,
      fill: header ? { color: 'E7E6E6' } : undefined,
      align: block.align[index] ?? 'left',
      fontSize: 11,
      fontFace: FONT,
      color: DARK,
      border: { type: 'solid', pt: 0.5, color: 'BFBFBF' },
    },
  });
  const row = (cells: Inline[][], header: boolean) =>
    Array.from({ length: columns }, (_, index) => cell(cells[index], header, index));
  return [row(block.header, true), ...block.rows.map((cells) => row(cells, false))];
}

function addSlide(pptx: Pptx, slide: Slide, index: number, titleSlide: boolean): void {
  const page = pptx.addSlide();
  page.background = { color: 'FFFFFF' };
  const tables = slide.body.filter(
    (block): block is Extract<Block, { type: 'table' }> => block.type === 'table'
  );
  const runs = bodyRuns(slide.body);
  const hasText = runs.some((run) => run.text && run.text.trim());

  if (titleSlide) {
    page.addText(runsOf(slide.title ?? [], { bold: true }), {
      x: MARGIN,
      y: 1.6,
      w: BODY_WIDTH,
      h: 1.2,
      fontFace: FONT,
      fontSize: 36,
      color: DARK,
      align: 'center',
      valign: 'middle',
      fit: 'shrink',
    });
    if (hasText) {
      page.addText(runs, {
        x: MARGIN,
        y: 2.9,
        w: BODY_WIDTH,
        h: 1.4,
        fontFace: FONT,
        fontSize: 18,
        color: '595959',
        align: 'center',
        valign: 'top',
        fit: 'shrink',
      });
    }
    return;
  }

  if (slide.title) {
    page.addText(runsOf(slide.title, { bold: true }), {
      x: MARGIN,
      y: MARGIN,
      w: BODY_WIDTH,
      h: TITLE_HEIGHT,
      fontFace: FONT,
      fontSize: 28,
      color: DARK,
      valign: 'middle',
      fit: 'shrink',
    });
    page.addShape(pptx.ShapeType.line, {
      x: MARGIN,
      y: MARGIN + TITLE_HEIGHT,
      w: BODY_WIDTH,
      h: 0,
      line: { color: ACCENT, width: 1.5 },
    });
  }
  const top = slide.title ? BODY_TOP : MARGIN;
  const available = slide.title ? BODY_HEIGHT : SLIDE.height - MARGIN * 2;
  const tableShare = tables.length > 0 ? (hasText ? 0.55 : 1) : 0;
  if (hasText) {
    page.addText(runs, {
      x: MARGIN,
      y: top,
      w: BODY_WIDTH,
      h: available * (1 - tableShare),
      fontFace: FONT,
      fontSize: 18,
      color: DARK,
      valign: 'top',
      fit: 'shrink',
      paraSpaceAfter: 4,
    });
  }
  tables.forEach((table, tableIndex) => {
    page.addTable(tableRows(table), {
      x: MARGIN,
      y: top + available * (1 - tableShare) + (tableIndex * available * tableShare) / tables.length,
      w: BODY_WIDTH,
      colW: BODY_WIDTH / Math.max(table.header.length, 1),
      fontFace: FONT,
      autoPage: false,
    });
  });
  page.addText(String(index + 1), {
    x: SLIDE.width - MARGIN - 0.6,
    y: SLIDE.height - 0.4,
    w: 0.6,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    color: '8C8C8C',
    align: 'right',
  });
}

export interface PptxOptions {
  title?: string;
}

export async function renderPptx(blocks: Block[], options: PptxOptions = {}): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Renkei';
  if (options.title) pptx.title = options.title;
  const slides = splitSlides(blocks);
  if (slides.length === 0)
    slides.push({ title: options.title ? [{ text: options.title }] : null, body: [] });
  slides.forEach((slide, index) => {
    const titleSlide =
      index === 0 &&
      slide.title !== null &&
      slides.length > 1 &&
      slide.body.every((block) => block.type === 'paragraph') &&
      slide.body.length <= 2;
    addSlide(pptx, slide, index, titleSlide);
  });
  const out = await pptx.write({ outputType: 'nodebuffer' });
  if (Buffer.isBuffer(out)) return out;
  if (out instanceof Uint8Array) return Buffer.from(out);
  if (out instanceof ArrayBuffer) return Buffer.from(out);
  throw new Error('pptxgenjs did not return a buffer');
}
