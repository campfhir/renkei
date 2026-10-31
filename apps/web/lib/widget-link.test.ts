import { openableWidgetLink } from './widget-link';

describe('openableWidgetLink', () => {
  it('allows https, mailto and webexteams', () => {
    expect(openableWidgetLink('https://example.atlassian.net/browse/OPS-1')).toBe(
      'https://example.atlassian.net/browse/OPS-1'
    );
    expect(openableWidgetLink('mailto:ann@example.com')).toBe('mailto:ann@example.com');
    expect(openableWidgetLink('webexteams://im?email=ann@example.com')).not.toBeNull();
    expect(openableWidgetLink('HTTPS://example.com/')).toBe('https://example.com/');
  });

  it('refuses every other scheme, relative URLs and junk', () => {
    for (const url of [
      'http://example.com/',
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'tel:+15555550100',
      'slack://open',
      'ms-msdt:/id',
      '/relative',
      '//evil.example/',
      '',
    ]) {
      expect(openableWidgetLink(url)).toBeNull();
    }
  });
});
