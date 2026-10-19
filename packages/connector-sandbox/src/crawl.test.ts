import {
  CRAWL_DEFAULT_PAGES,
  CRAWL_MAX_PAGES,
  crawlPatternRegExp,
  expandCrawlTemplate,
  inCrawlScope,
  inferCrawlPattern,
  planCrawl,
} from './crawl';

const ORIGIN = 'https://hl7-definition.caristix.com';
const SEGMENTS = `${ORIGIN}/v2/HL7v2.3/Segments`;

describe('crawl patterns', () => {
  it('matches one path segment with * and any depth with **', () => {
    expect(crawlPatternRegExp('/v2/HL7v2.3/Segments/*').test('/v2/HL7v2.3/Segments/AIG')).toBe(
      true
    );
    expect(crawlPatternRegExp('/v2/HL7v2.3/Segments/*').test('/v2/HL7v2.3/Segments/AIG/x')).toBe(
      false
    );
    expect(crawlPatternRegExp('/v2/HL7v2.3/Segments/*').test('/v2/HL7v2.3/Segments/AIG?x=1')).toBe(
      false
    );
    expect(crawlPatternRegExp('/docs/**').test('/docs/a/b/c')).toBe(true);
    // Regex characters in a path are literal.
    expect(crawlPatternRegExp('/v2/HL7v2.3/*').test('/v2/HL7v2x3/AIG')).toBe(false);
  });

  it('keeps a followed link on the origin and inside the pattern', () => {
    const recipe = { origin: ORIGIN, pattern: '/v2/HL7v2.3/Segments/*' };
    expect(inCrawlScope(`${SEGMENTS}/PID`, recipe)).toBe(true);
    expect(inCrawlScope(`${ORIGIN}/v2/HL7v2.4/Segments/PID`, recipe)).toBe(false);
    expect(inCrawlScope('https://evil.example/v2/HL7v2.3/Segments/PID', recipe)).toBe(false);
    expect(
      inCrawlScope(`https://user:pw@hl7-definition.caristix.com/v2/HL7v2.3/Segments/PID`, recipe)
    ).toBe(false);
    expect(inCrawlScope('not a url', recipe)).toBe(false);
  });

  it('encodes each template value into its one segment', () => {
    expect(
      expandCrawlTemplate({ url: `${SEGMENTS}/{value}`, values: ['AIG', '../../admin', 'a?b'] })
    ).toEqual([`${SEGMENTS}/AIG`, `${SEGMENTS}/..%2F..%2Fadmin`, `${SEGMENTS}/a%3Fb`]);
  });
});

describe('planCrawl', () => {
  it('turns a template into seeds, in order and deduplicated', () => {
    const plan = planCrawl({
      origin: ORIGIN,
      pattern: '/v2/HL7v2.3/Segments/*',
      template: { url: `${SEGMENTS}/{value}`, values: ['ACC', 'ADD', 'ACC'] },
    });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.seeds).toEqual([`${SEGMENTS}/ACC`, `${SEGMENTS}/ADD`]);
    expect(plan.recipe.maxPages).toBe(2);
    expect(plan.recipe.region).toBe('auto');
  });

  it('gives a following crawl the default page budget, capped at the maximum', () => {
    const follow = planCrawl({
      origin: `${ORIGIN}/ignored/path`,
      pattern: '/v2/HL7v2.3/Segments/*',
      follow: { from: [SEGMENTS], depth: 1 },
    });
    if (!follow.ok) throw new Error(follow.error);
    expect(follow.recipe.origin).toBe(ORIGIN);
    expect(follow.recipe.maxPages).toBe(CRAWL_DEFAULT_PAGES);
    const big = planCrawl({
      origin: ORIGIN,
      pattern: '/*',
      urls: [`${ORIGIN}/a`],
      maxPages: 10_000,
    });
    expect(big.ok && big.recipe.maxPages).toBe(CRAWL_MAX_PAGES);
  });

  it('refuses a crawl that could leave its origin or names nothing', () => {
    const cases: [unknown, string][] = [
      [
        { origin: 'http://example.com', pattern: '/*', urls: ['http://example.com/a'] },
        'https origin',
      ],
      [{ origin: ORIGIN, pattern: 'Segments/*', urls: [`${SEGMENTS}/A`] }, 'starting with "/"'],
      [{ origin: ORIGIN, pattern: '/*', urls: ['https://other.example/a'] }, 'is not a URL on'],
      [{ origin: ORIGIN, pattern: '/*' }, 'Name the pages'],
      [
        { origin: ORIGIN, pattern: '/*', template: { url: `${SEGMENTS}/x`, values: ['a'] } },
        '{value}',
      ],
      [{ origin: ORIGIN, pattern: '/*', follow: { from: [SEGMENTS], depth: 9 } }, 'follow.depth'],
    ];
    for (const [input, message] of cases) {
      const plan = planCrawl(input);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.error).toContain(message);
    }
  });
});

describe('inferCrawlPattern', () => {
  it('learns the pattern and the template from two segment pages', () => {
    const inferred = inferCrawlPattern([`${SEGMENTS}/AIG`, `${SEGMENTS}/ACC#top`]);
    if (!inferred.ok) throw new Error(inferred.error);
    expect(inferred.origin).toBe(ORIGIN);
    expect(inferred.pattern).toBe('/v2/HL7v2.3/Segments/*');
    expect(inferred.template).toEqual({ url: `${SEGMENTS}/{value}`, values: ['AIG', 'ACC'] });
  });

  it('ends in ** when the examples differ in depth, and wildcards differing query values', () => {
    const deep = inferCrawlPattern([`${ORIGIN}/docs/a`, `${ORIGIN}/docs/b/c`]);
    expect(deep.ok && deep.pattern).toBe('/docs/**');
    expect(deep.ok && deep.template).toBeNull();
    const query = inferCrawlPattern([`${ORIGIN}/item?id=1`, `${ORIGIN}/item?id=2`]);
    expect(query.ok && query.pattern).toBe('/item?id=*');
  });

  it('needs two examples on one https origin', () => {
    expect(inferCrawlPattern([`${SEGMENTS}/AIG`]).ok).toBe(false);
    expect(inferCrawlPattern([`${SEGMENTS}/AIG`, 'https://other.example/x']).ok).toBe(false);
  });
});
