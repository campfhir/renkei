import { PAGE_SIZE, pageFromParam, pageQuery, pageWindow, runsPageHref } from './runs-page.model';

const runs = (n: number) => Array.from({ length: n }, (_, index) => `run-${index + 1}`);

describe('the runs page number', () => {
  it('reads a whole page number from the URL, and treats anything else as page 1', () => {
    expect(
      ['3', ' 2 ', undefined, '', '0', '-2', '1.5', 'two', '99999999999999999999'].map(
        pageFromParam
      )
    ).toEqual([3, 2, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('asks for one row past the page, starting where the earlier pages end', () => {
    expect(pageQuery(1)).toEqual({ limit: PAGE_SIZE + 1, offset: 0 });
    expect(pageQuery(3)).toEqual({ limit: PAGE_SIZE + 1, offset: 2 * PAGE_SIZE });
  });
});

describe('the runs page window', () => {
  it('a full first page with more behind it shows 50 and offers Next but not Previous', () => {
    const window = pageWindow(runs(PAGE_SIZE + 1), 1);
    expect(window.rows).toHaveLength(PAGE_SIZE);
    expect(window).toMatchObject({ hasPrevious: false, hasNext: true, range: 'Runs 1–50' });
  });

  it('the last page offers Previous only, and numbers its rows from where it starts', () => {
    const window = pageWindow(runs(7), 3);
    expect(window).toMatchObject({ hasPrevious: true, hasNext: false, range: 'Runs 101–107' });
  });

  it('exactly one page of runs has no Next', () => {
    expect(pageWindow(runs(PAGE_SIZE), 1).hasNext).toBe(false);
  });

  it('a page past the end is empty, with no range, and still leads back', () => {
    expect(pageWindow([], 4)).toMatchObject({
      rows: [],
      hasPrevious: true,
      hasNext: false,
      range: null,
    });
  });
});

describe('runs page links', () => {
  const base = '/agents/a1/runs';

  it('keep the status tab and the search, and leave page 1 out of the URL', () => {
    expect(runsPageHref(base, { status: 'failed', q: 'jira', page: 2 })).toBe(
      '/agents/a1/runs?status=failed&q=jira&page=2'
    );
    expect(runsPageHref(base, { status: 'failed', page: 1 })).toBe('/agents/a1/runs?status=failed');
    expect(runsPageHref(base, { page: 1 })).toBe(base);
  });
});
