/**
 * Atlassian Document Format -> Markdown.
 *
 * REST v3 returns descriptions and comments as ADF node trees. Handing those
 * to a model raw costs several times the tokens of the equivalent prose and
 * reads badly, so every text field crossing the tool boundary goes through
 * here first.
 *
 * Unknown node types recurse into their children rather than being dropped:
 * ADF gains node types over time, and losing a paragraph of text is worse
 * than losing its formatting.
 */
import { asString } from '@/lib/util/coerce';

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown> | undefined;
}

export interface AdfNode {
  type?: string | undefined;
  text?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  content?: AdfNode[] | undefined;
  marks?: AdfMark[] | undefined;
}

const INDENT = '  ';

export function adfToMarkdown(document: unknown): string {
  if (!isNode(document)) {
    return '';
  }

  return renderBlocks(childrenOf(document), 0).trim();
}

/** True for an ADF document that renders to nothing — an empty description. */
export function isEmptyAdf(document: unknown): boolean {
  return adfToMarkdown(document).length === 0;
}

function renderBlocks(nodes: readonly AdfNode[], depth: number): string {
  return nodes
    .map((node) => renderBlock(node, depth))
    .filter((block) => block.length > 0)
    .join('\n\n');
}

function renderBlock(node: AdfNode, depth: number): string {
  switch (node.type) {
    case 'paragraph':
      return renderInline(childrenOf(node));

    case 'heading': {
      const level = clampHeadingLevel(node.attrs?.level);
      return `${'#'.repeat(level)} ${renderInline(childrenOf(node))}`;
    }

    case 'bulletList':
      return renderList(node, depth, () => '- ');

    case 'orderedList': {
      const start = typeof node.attrs?.order === 'number' ? node.attrs.order : 1;
      return renderList(node, depth, (index) => `${start + index}. `);
    }

    case 'taskList':
      return renderList(node, depth, (_index, item) =>
        item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] '
      );

    case 'decisionList':
      return renderList(node, depth, () => '- ');

    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const code = childrenOf(node)
        .map((child) => child.text ?? '')
        .join('');
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    case 'blockquote':
      return prefixLines(renderBlocks(childrenOf(node), depth), '> ');

    case 'panel': {
      const kind = typeof node.attrs?.panelType === 'string' ? node.attrs.panelType : 'note';
      const body = renderBlocks(childrenOf(node), depth);
      return prefixLines(`**${kind.toUpperCase()}**\n\n${body}`, '> ');
    }

    case 'rule':
      return '---';

    case 'table':
      return renderTable(node);

    case 'expand':
    case 'nestedExpand': {
      const title = typeof node.attrs?.title === 'string' ? node.attrs.title : 'Details';
      const body = renderBlocks(childrenOf(node), depth);
      return body ? `**${title}**\n\n${body}` : `**${title}**`;
    }

    case 'mediaSingle':
    case 'mediaGroup':
      return childrenOf(node)
        .map((child) => renderMedia(child))
        .filter(Boolean)
        .join('\n');

    case 'media':
      return renderMedia(node);

    // Leaf inline nodes can appear where a block is expected in malformed docs.
    case 'text':
    case 'mention':
    case 'emoji':
    case 'inlineCard':
    case 'status':
    case 'date':
      return renderInline([node]);

    default: {
      const nested = childrenOf(node);
      return nested.length > 0 ? renderBlocks(nested, depth) : '';
    }
  }
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList', 'decisionList']);

function renderList(
  node: AdfNode,
  depth: number,
  marker: (index: number, item: AdfNode) => string
): string {
  const indent = INDENT.repeat(depth);

  return childrenOf(node)
    .map((item, index) => {
      const bullet = marker(index, item);
      const parts = childrenOf(item);

      // A nested list indents itself from `depth + 1` and must follow on the
      // next line, not after a blank one — markdown treats a blank line plus
      // indentation as a code block.
      const nested = parts.filter((part) => LIST_TYPES.has(part.type ?? ''));
      const own = parts.filter((part) => !LIST_TYPES.has(part.type ?? ''));

      const [first = '', ...rest] = renderBlocks(own, depth + 1).split('\n');
      const hangingIndent = `${indent}${' '.repeat(bullet.length)}`;
      const continuation = rest.map((line) => (line.length > 0 ? `${hangingIndent}${line}` : ''));
      const sublists = nested.map((list) => renderBlock(list, depth + 1)).filter(Boolean);

      return [`${indent}${bullet}${first}`, ...continuation, ...sublists].join('\n');
    })
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

function renderTable(node: AdfNode): string {
  const rows = childrenOf(node)
    .filter((row) => row.type === 'tableRow')
    .map((row) => childrenOf(row).map((cell) => renderCell(cell)));

  if (rows.length === 0) {
    return '';
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const firstRowIsHeader = childrenOf(node)
    .find((row) => row.type === 'tableRow')
    ?.content?.every((cell) => cell.type === 'tableHeader');

  const pad = (row: string[]): string[] =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? '');

  const [firstRow = [], ...remainingRows] = rows;
  const header = firstRowIsHeader ? pad(firstRow) : Array.from({ length: columnCount }, () => '');
  const bodyRows = firstRowIsHeader ? remainingRows : rows;

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`,
    ...bodyRows.map((row) => `| ${pad(row).join(' | ')} |`),
  ];

  return lines.join('\n');
}

function renderCell(cell: AdfNode): string {
  return renderBlocks(childrenOf(cell), 0).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

function renderMedia(node: AdfNode): string {
  const attrs = node.attrs ?? {};
  const name =
    (typeof attrs.alt === 'string' && attrs.alt) ||
    (typeof attrs.id === 'string' && attrs.id) ||
    'file';

  // Deliberately not a link: attachment content needs its own authenticated
  // fetch, so a URL here would be an invitation to a dead end.
  return `[attachment: ${name}]`;
}

function renderInline(nodes: readonly AdfNode[]): string {
  return nodes.map((node) => renderInlineNode(node)).join('');
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return applyMarks(node.text ?? '', node.marks ?? []);

    case 'hardBreak':
      return '\n';

    case 'mention': {
      const text = node.attrs?.text;
      return typeof text === 'string' ? text : `@${asString(node.attrs?.id, 'unknown')}`;
    }

    case 'emoji': {
      const attrs = node.attrs ?? {};
      if (typeof attrs.text === 'string') return attrs.text;
      return typeof attrs.shortName === 'string' ? attrs.shortName : '';
    }

    case 'inlineCard': {
      const url = node.attrs?.url;
      return typeof url === 'string' ? `<${url}>` : '';
    }

    case 'status': {
      const text = node.attrs?.text;
      return typeof text === 'string' ? `[${text}]` : '';
    }

    case 'date': {
      const timestamp = Number(node.attrs?.timestamp);
      if (!Number.isFinite(timestamp)) return '';
      return new Date(timestamp).toISOString().slice(0, 10);
    }

    case 'media':
      return renderMedia(node);

    default: {
      const nested = childrenOf(node);
      return nested.length > 0 ? renderInline(nested) : (node.text ?? '');
    }
  }
}

function applyMarks(text: string, marks: readonly AdfMark[]): string {
  if (text.length === 0 || marks.length === 0) {
    return text;
  }

  const types = new Set(marks.map((mark) => mark.type));
  let output = text;

  if (types.has('code')) {
    // Emphasis inside a code span is literal, so the other marks are dropped
    // rather than emitted as visible asterisks.
    output = `\`${output}\``;
  } else {
    if (types.has('strong')) output = `**${output}**`;
    if (types.has('em')) output = `*${output}*`;
    if (types.has('strike')) output = `~~${output}~~`;
  }

  const link = marks.find((mark) => mark.type === 'link');
  const href = link?.attrs?.href;
  if (typeof href === 'string' && href.length > 0) {
    output = `[${output}](${href})`;
  }

  return output;
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join('\n');
}

function clampHeadingLevel(level: unknown): number {
  const parsed = typeof level === 'number' ? Math.trunc(level) : 1;
  return Math.min(6, Math.max(1, parsed));
}

/**
 * A predicate rather than a cast: the lint rules here forbid type assertions,
 * and every field of `AdfNode` is optional, so any plain object qualifies.
 */
function isNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childrenOf(node: AdfNode): AdfNode[] {
  const content: unknown = node.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((child): child is AdfNode => isNode(child));
}
