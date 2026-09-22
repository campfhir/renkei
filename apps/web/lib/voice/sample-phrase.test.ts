import { samplePhrase } from './sample-phrase';

describe('samplePhrase', () => {
  it('speaks the language of the tag, whatever its region', () => {
    expect(samplePhrase('en-US')).toMatch(/^Hello/);
    expect(samplePhrase('en-IN')).toMatch(/^Hello/);
    expect(samplePhrase('es-MX')).toMatch(/^Hola/);
    expect(samplePhrase('fr-CA')).toMatch(/^Bonjour/);
  });

  it('writes Chinese the way the region does', () => {
    expect(samplePhrase('zh-CN')).toContain('回复');
    expect(samplePhrase('zh-TW')).toContain('回覆');
    expect(samplePhrase('zh-HK')).toContain('回覆');
  });

  it('speaks Cantonese for yue, not English', () => {
    expect(samplePhrase('yue-CN')).toContain('回覆');
    expect(samplePhrase('yue')).toContain('回覆');
  });

  it('takes an underscore or odd casing in its stride', () => {
    expect(samplePhrase('ZH_tw')).toBe(samplePhrase('zh-TW'));
    expect(samplePhrase('JA-jp')).toBe(samplePhrase('ja-JP'));
  });

  it('falls back to English for a language it has no sentence for', () => {
    expect(samplePhrase('tlh-XX')).toMatch(/^Hello/);
    expect(samplePhrase('')).toMatch(/^Hello/);
  });
});
