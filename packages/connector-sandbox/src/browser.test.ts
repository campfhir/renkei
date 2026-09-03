/**
 * The snapshot vocabulary's own contract: refs are the narrow shape the
 * walk mints, sizes clamp into the allowed range, and a rendered snapshot
 * keeps its header while cutting the body at a line boundary with a note.
 */

import {
  BROWSER_SNAPSHOT_DEFAULT_CHARS,
  BROWSER_SNAPSHOT_MAX_CHARS,
  isBrowserRef,
  renderBrowserSnapshot,
  renderSnapshotNode,
  snapshotCharsOf,
  type BrowserSnapshotNode,
} from './browser';

describe('isBrowserRef', () => {
  it('accepts the e<digits> shape and nothing else', () => {
    expect(isBrowserRef('e1')).toBe(true);
    expect(isBrowserRef('e12345')).toBe(true);
    expect(isBrowserRef('e123456')).toBe(false);
    expect(isBrowserRef('E1')).toBe(false);
    expect(isBrowserRef('e')).toBe(false);
    expect(isBrowserRef('#login')).toBe(false);
    expect(isBrowserRef('e1"] , body [x="')).toBe(false);
    expect(isBrowserRef(1)).toBe(false);
  });
});

describe('snapshotCharsOf', () => {
  it('defaults when absent or unusable, and clamps to the ceiling', () => {
    expect(snapshotCharsOf(undefined)).toBe(BROWSER_SNAPSHOT_DEFAULT_CHARS);
    expect(snapshotCharsOf(-5)).toBe(BROWSER_SNAPSHOT_DEFAULT_CHARS);
    expect(snapshotCharsOf('lots')).toBe(BROWSER_SNAPSHOT_DEFAULT_CHARS);
    expect(snapshotCharsOf(500.9)).toBe(500);
    expect(snapshotCharsOf(10_000_000)).toBe(BROWSER_SNAPSHOT_MAX_CHARS);
  });
});

describe('renderSnapshotNode', () => {
  it('renders each role the way the model reads it', () => {
    expect(renderSnapshotNode({ role: 'heading', level: 2, name: 'Sign in' })).toBe('## Sign in');
    expect(renderSnapshotNode({ role: 'text', name: 'Welcome back.' })).toBe('Welcome back.');
    expect(renderSnapshotNode({ role: 'image', name: 'Logo' })).toBe('[image "Logo"]');
    expect(renderSnapshotNode({ role: 'landmark', tag: 'nav', name: 'Main' })).toBe('<nav "Main">');
    expect(
      renderSnapshotNode({
        role: 'link',
        ref: 'e1',
        name: 'Docs',
        href: 'https://example.com/docs',
      })
    ).toBe('[e1] link "Docs" → https://example.com/docs');
    expect(renderSnapshotNode({ role: 'textbox', ref: 'e2', name: 'Email', value: 'a@b.c' })).toBe(
      '[e2] textbox "Email" = "a@b.c"'
    );
    expect(
      renderSnapshotNode({ role: 'checkbox', ref: 'e3', name: 'Remember me', checked: true })
    ).toBe('[e3] checkbox "Remember me" (checked)');
    expect(
      renderSnapshotNode({
        role: 'combobox',
        ref: 'e4',
        name: 'Country',
        value: 'Canada',
        options: ['Canada', 'US'],
        disabled: true,
      })
    ).toBe('[e4] combobox "Country" = "Canada" (disabled) options: "Canada", "US"');
  });

  it('escapes quotes inside names so a line stays unambiguous', () => {
    expect(renderSnapshotNode({ role: 'button', ref: 'e9', name: 'Say "hi"' })).toBe(
      '[e9] button "Say \\"hi\\""'
    );
  });
});

describe('renderBrowserSnapshot', () => {
  const page = { url: 'https://example.com/', title: 'Example' };
  const nodes: BrowserSnapshotNode[] = [
    { role: 'heading', level: 1, name: 'Example Domain' },
    { role: 'text', name: 'This domain is for use in illustrative examples.' },
    { role: 'link', ref: 'e1', name: 'More information...', href: 'https://iana.org/domains' },
  ];

  it('renders header, body, and no note when everything fits', () => {
    const rendered = renderBrowserSnapshot(page, nodes, 10_000);
    expect(rendered.truncated).toBe(false);
    expect(rendered.snapshot).toBe(
      'Page: Example\nURL: https://example.com/\n---\n' +
        '# Example Domain\n' +
        'This domain is for use in illustrative examples.\n' +
        '[e1] link "More information..." → https://iana.org/domains'
    );
  });

  it('cuts at a line boundary and says so', () => {
    const rendered = renderBrowserSnapshot(page, nodes, 80);
    expect(rendered.truncated).toBe(true);
    expect(rendered.snapshot).toContain('# Example Domain');
    expect(rendered.snapshot).not.toContain('illustrative');
    expect(rendered.snapshot).toContain('[snapshot truncated at 1 of 3 items');
  });

  it('marks a walk the worker itself cut short even when every line fits', () => {
    const rendered = renderBrowserSnapshot(page, nodes, 10_000, true);
    expect(rendered.truncated).toBe(true);
    expect(rendered.snapshot).toContain('3 of 3+ items');
  });

  it('never drops the header, whatever the budget', () => {
    const rendered = renderBrowserSnapshot(page, nodes, 1);
    expect(rendered.snapshot.startsWith('Page: Example\nURL: https://example.com/')).toBe(true);
  });
});
