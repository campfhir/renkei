import { summarizeReadme } from './readme-summary';

describe('a description from the README', () => {
  it('skips the title, badges and images and takes the first paragraph', () => {
    const text = [
      '# Ledger',
      '',
      '[![CI](https://x/badge.svg)](https://x)',
      '![logo](logo.png)',
      '',
      'A **double-entry** ledger service, see [docs](https://d).',
      'It speaks gRPC.',
      '',
      '## Install',
    ].join('\n');
    expect(summarizeReadme(text)).toBe('A double-entry ledger service, see docs. It speaks gRPC.');
  });

  it('passes over code, tables and raw HTML', () => {
    const text = '<p align="center">\n```\nnpm i\n```\n| a | b |\n\nReal words about the project here.';
    expect(summarizeReadme(text)).toBe('Real words about the project here.');
  });

  it('gives nothing for a README with no prose', () => {
    expect(summarizeReadme('# Title\n\n![x](y.png)\n')).toBeNull();
    expect(summarizeReadme('')).toBeNull();
  });

  it('cuts a long paragraph at a sentence, or at a word with an ellipsis', () => {
    const sentence = 'This is a sentence about things. ';
    const long = summarizeReadme(sentence.repeat(30))!;
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith('.')).toBe(true);
    const words = summarizeReadme('word '.repeat(200))!;
    expect(words.endsWith('…')).toBe(true);
    expect(words.length).toBeLessThanOrEqual(300);
  });
});
