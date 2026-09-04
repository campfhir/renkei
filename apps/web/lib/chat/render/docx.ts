/**
 * Blocks → a Word document, with the `docx` package. Headings map to
 * Word's own heading styles (so the navigation pane and a table of
 * contents work), lists to real numbering (nested up to six levels),
 * tables to bordered tables with a shaded header row, code to Consolas
 * on a light ground, quotes to an indented italic paragraph, and a rule
 * to a bottom border on an empty paragraph.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';
import type { Align, Block, Inline, ListItem } from './markdown-blocks';

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const CODE_FONT = 'Consolas';
const CODE_SHADE = 'F2F2F2';
const HEADER_SHADE = 'E7E6E6';
const LIST_LEVELS = 6;
const BULLET_REF = 'renkei-bullets';
const NUMBER_REF = 'renkei-numbers';

const ALIGNMENT: Record<NonNullable<Align>, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
};

function runsOf(inlines: Inline[]): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const inline of inlines) {
    const lines = inline.text.split('\n');
    const runs: TextRun[] = lines.map(
      (line, index) =>
        new TextRun({
          text: line,
          bold: inline.bold,
          italics: inline.italic,
          strike: inline.strike,
          ...(inline.code
            ? { font: CODE_FONT, shading: { type: ShadingType.CLEAR, fill: CODE_SHADE } }
            : {}),
          ...(inline.href ? { style: 'Hyperlink' } : {}),
          break: index > 0 ? 1 : undefined,
        })
    );
    if (inline.href) out.push(new ExternalHyperlink({ link: inline.href, children: runs }));
    else out.push(...runs);
  }
  return out;
}

function paragraph(inlines: Inline[], options: IParagraphOptions = {}): Paragraph {
  return new Paragraph({ ...options, children: runsOf(inlines) });
}

function codeBlock(text: string): Paragraph[] {
  return text.split('\n').map(
    (line) =>
      new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: CODE_SHADE },
        spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: line || ' ', font: CODE_FONT, size: 18 })],
      })
  );
}

function listParagraphs(
  ordered: boolean,
  items: ListItem[],
  level: number,
  numberingInstance: () => number
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  // A fresh numbering instance per ordered list so each restarts at 1.
  const instance = ordered ? numberingInstance() : 0;
  for (const item of items) {
    out.push(
      paragraph(item.inlines, {
        numbering: {
          reference: ordered ? NUMBER_REF : BULLET_REF,
          level: Math.min(level, LIST_LEVELS - 1),
          instance,
        },
      })
    );
    for (const child of item.children) {
      if (child.type === 'list') {
        out.push(...listParagraphs(child.ordered, child.items, level + 1, numberingInstance));
      } else {
        out.push(...blockChildren([child], numberingInstance));
      }
    }
  }
  return out;
}

function tableOf(block: Extract<Block, { type: 'table' }>): Table {
  const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
  const cell = (inlines: Inline[], index: number, header: boolean) => {
    const align = block.align[index];
    return new TableCell({
      shading: header ? { type: ShadingType.CLEAR, fill: HEADER_SHADE } : undefined,
      children: [
        paragraph(header ? inlines.map((run) => ({ ...run, bold: true })) : inlines, {
          alignment: align ? ALIGNMENT[align] : undefined,
        }),
      ],
    });
  };
  const rowOf = (cells: Inline[][], header: boolean) =>
    new TableRow({
      tableHeader: header,
      children: Array.from({ length: columns }, (_, index) =>
        cell(cells[index] ?? [], index, header)
      ),
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [rowOf(block.header, true), ...block.rows.map((row) => rowOf(row, false))],
  });
}

function blockChildren(blocks: Block[], numberingInstance: () => number): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(paragraph(block.inlines, { heading: HEADINGS[block.level - 1] }));
        break;
      case 'paragraph':
        out.push(paragraph(block.inlines, { spacing: { after: 160 } }));
        break;
      case 'list':
        out.push(...listParagraphs(block.ordered, block.items, 0, numberingInstance));
        break;
      case 'code':
        out.push(...codeBlock(block.text));
        out.push(new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }));
        break;
      case 'table':
        out.push(tableOf(block));
        out.push(new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }));
        break;
      case 'quote':
        out.push(...quoteChildren(block.blocks, numberingInstance));
        break;
      case 'rule':
        out.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BFBFBF', space: 1 } },
            children: [],
          })
        );
        break;
    }
  }
  return out;
}

function quoteChildren(blocks: Block[], numberingInstance: () => number): (Paragraph | Table)[] {
  // Quotes render their paragraphs indented and italic; anything else as is.
  const out: (Paragraph | Table)[] = [];
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      out.push(
        paragraph(
          block.inlines.map((run) => ({ ...run, italic: true })),
          {
            indent: { left: 720 },
            spacing: { after: 160 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BFBFBF', space: 8 } },
          }
        )
      );
    } else if (block.type === 'quote') {
      out.push(...quoteChildren(block.blocks, numberingInstance));
    } else {
      out.push(...blockChildren([block], numberingInstance));
    }
  }
  return out;
}

function levels(format: (typeof LevelFormat)[keyof typeof LevelFormat] | 'bullet') {
  const bullets = ['•', '◦', '▪'];
  return Array.from({ length: LIST_LEVELS }, (_, level) => ({
    level,
    format: format === 'bullet' ? LevelFormat.BULLET : format,
    text: format === 'bullet' ? bullets[level % bullets.length]! : `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  }));
}

export interface DocxOptions {
  title?: string;
}

export async function renderDocx(blocks: Block[], options: DocxOptions = {}): Promise<Buffer> {
  let instances = 0;
  const numberingInstance = () => {
    instances += 1;
    return instances;
  };
  const children = blockChildren(blocks, numberingInstance);
  if (children.length === 0) children.push(new Paragraph({ children: [] }));
  const document = new Document({
    title: options.title,
    creator: 'Renkei',
    numbering: {
      config: [
        { reference: BULLET_REF, levels: levels('bullet') },
        { reference: NUMBER_REF, levels: levels(LevelFormat.DECIMAL) },
      ],
    },
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(document);
}
