import { isFreeEmailDomain } from './free-email-domains';

describe('isFreeEmailDomain', () => {
  it.each(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'])(
    'flags %s',
    (domain) => {
      expect(isFreeEmailDomain(domain)).toBe(true);
    }
  );

  it('is case-insensitive', () => {
    expect(isFreeEmailDomain('Gmail.COM')).toBe(true);
  });

  it('does not flag a company domain', () => {
    expect(isFreeEmailDomain('acme.com')).toBe(false);
  });

  it('does not flag a domain merely containing a free provider as a substring', () => {
    expect(isFreeEmailDomain('notgmail.com')).toBe(false);
    expect(isFreeEmailDomain('gmail.com.acme.com')).toBe(false);
  });
});
