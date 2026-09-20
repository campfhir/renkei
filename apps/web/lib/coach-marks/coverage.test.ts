import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COACH_MARK_TOURS } from './tours';

/**
 * docs/coach-mark-coverage.md is the list of features and which tour, if
 * any, explains each. It is the map for growing the coach marks, so it
 * must not drift from the registry: a tour that ships has to be on the
 * list, and the list must not name a tour that no longer exists.
 */
const DOC = join(__dirname, '..', '..', '..', '..', 'docs', 'coach-mark-coverage.md');

/** Every backticked id in a "Tour" column across the doc's tables. */
function tourIdsInDoc(markdown: string): Set<string> {
  const ids = new Set<string>();
  let tourColumn = -1;
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      tourColumn = -1;
      continue;
    }
    const cells = line.split('|').map((cell) => cell.trim());
    if (tourColumn === -1) {
      tourColumn = cells.indexOf('Tour');
      continue;
    }
    const cell = cells[tourColumn] ?? '';
    for (const match of cell.matchAll(/`([a-z][a-z0-9-]*)`/g)) ids.add(match[1]);
  }
  return ids;
}

describe('docs/coach-mark-coverage.md', () => {
  const doc = readFileSync(DOC, 'utf8');
  const listed = tourIdsInDoc(doc);

  it('lists every tour in the registry', () => {
    for (const tour of COACH_MARK_TOURS) expect(listed).toContain(tour.id);
  });

  it('names no tour the registry does not have', () => {
    const known = new Set(COACH_MARK_TOURS.map((tour) => tour.id));
    for (const id of listed) expect(known).toContain(id);
  });

  it('has a status on every row', () => {
    for (const line of doc.split('\n')) {
      if (!line.startsWith('| ') || line.includes('---') || /\| (Feature|Connector) /.test(line)) {
        continue;
      }
      expect(line).toMatch(/\| (Covered|Partial|None)\s*\|$/);
    }
  });
});
