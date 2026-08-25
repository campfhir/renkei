/**
 * The card reads its links out of the confirm tool's own reply text, so
 * this parser is what stands between "Created ENG-789" and a clickable
 * ticket. It is also the only widget logic that can be tested without a
 * browser, which is reason enough to keep it pure.
 */

import { parseLinks } from './ui';

describe('parseLinks', () => {
  it('pulls the links a Jira reply carries', () => {
    const text =
      'Created issue ENG-789\n\n[Open in Jira](https://nems.atlassian.net/browse/ENG-789) · ' +
      '[Customer portal](https://nems.atlassian.net/servicedesk/customer/portals/all/requests/ENG-789)';
    expect(parseLinks(text)).toEqual([
      { label: 'Open in Jira', href: 'https://nems.atlassian.net/browse/ENG-789' },
      {
        label: 'Customer portal',
        href: 'https://nems.atlassian.net/servicedesk/customer/portals/all/requests/ENG-789',
      },
    ]);
  });

  it('finds nothing in a reply that carries no link', () => {
    expect(parseLinks('Sent to dana@example.com')).toEqual([]);
  });

  it('ignores a non-http target rather than rendering an unopenable anchor', () => {
    // javascript: and data: URLs in a card would be a real hazard, and a
    // relative path means nothing inside a sandboxed iframe.
    expect(parseLinks('[click](javascript:alert(1))')).toEqual([]);
    expect(parseLinks('[docs](/local/path)')).toEqual([]);
  });

  it('de-duplicates the same destination', () => {
    const text = '[Open](https://x.test/a) and again [Open in Jira](https://x.test/a)';
    expect(parseLinks(text)).toHaveLength(1);
  });

  it('stops the URL at the closing paren, not at the end of the line', () => {
    const links = parseLinks('see [one](https://x.test/a) then [two](https://x.test/b) done');
    expect(links.map((link) => link.href)).toEqual(['https://x.test/a', 'https://x.test/b']);
  });
});
