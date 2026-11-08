import { AGENTS_PAGE_SIZE, agentsPageHref, cardsPage, listPage } from './agents-page.model';

const items = (n: number, prefix = 'a') =>
  Array.from({ length: n }, (_, index) => `${prefix}${index + 1}`);

describe('paging the agents page ten at a time', () => {
  it('ten or fewer is one page with nothing to page through', () => {
    expect(listPage(items(10), 1)).toMatchObject({
      pageCount: 1,
      hasPrevious: false,
      hasNext: false,
      range: '1–10 of 10',
    });
  });

  it('the eleventh agent starts a second page', () => {
    const first = listPage(items(11), 1);
    expect(first.rows).toHaveLength(AGENTS_PAGE_SIZE);
    expect(first).toMatchObject({ pageCount: 2, hasNext: true, range: '1–10 of 11' });
    expect(listPage(items(11), 2)).toMatchObject({
      rows: ['a11'],
      hasPrevious: true,
      hasNext: false,
      range: '11–11 of 11',
    });
  });

  it('a page past the end shows the last page, and a page before the first shows the first', () => {
    expect(listPage(items(23), 9)).toMatchObject({ page: 3, rows: ['a21', 'a22', 'a23'] });
    expect(listPage(items(23), 0).page).toBe(1);
  });

  it('no agents at all is one empty page with no range', () => {
    expect(listPage([], 2)).toMatchObject({ rows: [], page: 1, pageCount: 1, range: null });
  });
});

describe('the agent cards’ pages', () => {
  it('own agents come first, and shared ones continue on the page where they run out', () => {
    const own = items(8, 'own');
    const shared = items(5, 'shared');
    const first = cardsPage(own, shared, 1);
    expect(first.agents).toEqual(own);
    expect(first.shared).toEqual(['shared1', 'shared2']);
    expect(first.paging.range).toBe('1–10 of 13');
    const second = cardsPage(own, shared, 2);
    expect(second.agents).toEqual([]);
    expect(second.shared).toEqual(['shared3', 'shared4', 'shared5']);
  });

  it('a page of only own agents holds no shared ones', () => {
    const page = cardsPage(items(25, 'own'), items(3, 'shared'), 2);
    expect(page.agents).toEqual(items(25, 'own').slice(10, 20));
    expect(page.shared).toEqual([]);
  });
});

describe('agents page links', () => {
  it('keep both places, leave page 1 out, and land on an anchor when asked', () => {
    expect(agentsPageHref({ inflight: 2, page: 3 })).toBe('/agents?inflight=2&page=3');
    expect(agentsPageHref({ inflight: 1, page: 2 }, 'agents-list')).toBe(
      '/agents?page=2#agents-list'
    );
    expect(agentsPageHref({ inflight: 1, page: 1 })).toBe('/agents');
  });
});
