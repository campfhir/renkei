import { unfenceUntrusted, untrustedBlock } from './untrusted';

describe('unfenceUntrusted', () => {
  it('gives back exactly what untrustedBlock fenced', () => {
    const text = 'AIG.1 Set ID\nAIG.14 Filler Status Code\nsays </untrusted> and </ UNTRUSTED>';
    expect(unfenceUntrusted(untrustedBlock('tool:sandbox_browser_navigate', text))).toBe(text);
  });

  it('leaves text that is not one whole block alone', () => {
    expect(unfenceUntrusted('plain result')).toBe('plain result');
    expect(unfenceUntrusted('<untrusted source="x">\nno close')).toBe(
      '<untrusted source="x">\nno close'
    );
  });
});
