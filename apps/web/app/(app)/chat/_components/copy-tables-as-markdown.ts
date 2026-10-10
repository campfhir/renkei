/**
 * Copying a selection out of rendered Markdown normally hands the clipboard
 * whatever the browser makes of the DOM — which for a table is tab-separated
 * cells at best and, on the narrow-screen card layout, one bare value per
 * line with no column names at all. When a selection reaches into a table,
 * this rebuilds the plain-text copy with each table written back out as a
 * GitHub-flavored Markdown table, so it pastes into a ticket, a wiki page,
 * or another chat as a table again. Selections that touch no table cell
 * are left to the browser.
 */

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'HR',
]);

/** Whether a cloned selection contains any part of a table's structure. */
function touchesTable(fragment: DocumentFragment): boolean {
  return fragment.querySelector('table, tr, td, th') !== null;
}

/** A cell's text on one line, with pipes escaped so they don't split it. */
function cellText(cell: Element): string {
  return (cell.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function isCell(node: Element): boolean {
  return node.tagName === 'TD' || node.tagName === 'TH';
}

/**
 * The rows of a selected table. A selection that stays inside one row
 * clones its cells with no row around them (the row is the range's common
 * ancestor, which cloneContents leaves out), so a node holding cells
 * directly counts as a row itself.
 */
function tableRows(container: Element | DocumentFragment): (Element | DocumentFragment)[] {
  if (container instanceof Element && container.tagName === 'TR') return [container];
  if ([...container.children].some(isCell)) return [container];
  return [...container.querySelectorAll('tr')];
}

const TABLE_PARTS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);

/**
 * Whether a node is table structure that should be written as one table:
 * a table or part of one, or a node holding rows, row groups or cells
 * directly, as a clone of a selection that starts and ends inside one
 * table does.
 */
function isTableLike(node: Element | DocumentFragment): boolean {
  if (node instanceof Element && TABLE_PARTS.has(node.tagName)) return true;
  return [...node.children].some((child) => isCell(child) || TABLE_PARTS.has(child.tagName));
}

/**
 * A table (or the part of one that was selected) as a Markdown table. The
 * header row comes from <th> cells when they were selected; otherwise from
 * the data-label each body cell carries, so a selection that starts in the
 * middle of a table still pastes with its column names.
 */
function tableToMarkdown(table: Element | DocumentFragment): string {
  const rows = tableRows(table);
  let header: string[] = [];
  const body: string[][] = [];
  for (const row of rows) {
    const cells = [...row.children].filter(isCell);
    if (cells.length === 0) continue;
    if (header.length === 0 && cells.every((cell) => cell.tagName === 'TH')) {
      header = cells.map(cellText);
      continue;
    }
    body.push(cells.map(cellText));
  }
  // One lone cell reads better as its text than as a one-column table.
  const cellCount = header.length + body.reduce((count, row) => count + row.length, 0);
  if (cellCount === 1) return (header[0] ?? body[0]?.[0] ?? '').replace(/\\\|/g, '|');
  if (header.length === 0 && body.length > 0) {
    const firstRow = rows.find((row) => [...row.children].some((cell) => cell.tagName === 'TD'));
    const labels = [...(firstRow?.children ?? [])]
      .filter((cell) => cell.tagName === 'TD')
      .map((cell) => cell.getAttribute('data-label') ?? '');
    if (labels.some(Boolean)) header = labels;
  }
  const width = Math.max(header.length, ...body.map((row) => row.length));
  if (width === 0) return '';
  const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill('')];
  const line = (row: string[]) => `| ${pad(row).join(' | ')} |`;
  const lines = [line(header), line(Array<string>(width).fill('---')), ...body.map(line)];
  return lines.join('\n');
}

/** Plain text for a node, with tables written as Markdown. */
function serialize(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (node instanceof Element) {
    if (node.tagName === 'BR') return '\n';
  } else if (!(node instanceof DocumentFragment)) {
    return '';
  }
  if (isTableLike(node)) return `\n${tableToMarkdown(node)}\n`;
  const tag = node instanceof Element ? node.tagName : '';
  const inner = [...node.childNodes].map(serialize).join('');
  if (tag === 'LI') return `${inner}\n`;
  if (BLOCK_TAGS.has(tag)) return `\n${inner}\n`;
  return inner;
}

/**
 * Writes the current selection to the clipboard with its tables as Markdown.
 * Returns false, having done nothing, when the selection holds no table, so
 * the browser's own copy runs instead.
 */
export function copySelectionWithMarkdownTables(event: ClipboardEvent): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (!event.clipboardData) return false;
  const fragment = selection.getRangeAt(0).cloneContents();
  if (!touchesTable(fragment)) return false;
  const text = serialize(fragment)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const holder = document.createElement('div');
  holder.appendChild(fragment);
  event.clipboardData.setData('text/plain', text);
  event.clipboardData.setData('text/html', holder.innerHTML);
  event.preventDefault();
  return true;
}
