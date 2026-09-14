import { parseDotenv } from './dotenv';

describe('parseDotenv', () => {
  it('reads the common shapes', () => {
    const parsed = parseDotenv(
      [
        '# a comment',
        '',
        'PLAIN=hello world',
        'export EXPORTED=yes',
        'SPACED = padded  ',
        'SINGLE=\'keep "quotes" #here\'',
        'DOUBLE="line\\none \\"quoted\\""',
        'TRAIL=value # a comment',
        'HASH=a#b',
        'EMPTY=',
      ].join('\n')
    );
    expect(parsed.values).toEqual({
      PLAIN: 'hello world',
      EXPORTED: 'yes',
      SPACED: 'padded',
      SINGLE: 'keep "quotes" #here',
      DOUBLE: 'line\none "quoted"',
      TRAIL: 'value',
      HASH: 'a#b',
      EMPTY: '',
    });
    expect(parsed.problems).toEqual([]);
  });

  it('reads a multi-line double-quoted value and CRLF', () => {
    const parsed = parseDotenv('KEY="first\r\nsecond"\r\nNEXT=1\r\n');
    expect(parsed.values).toEqual({ KEY: 'first\nsecond', NEXT: '1' });
  });

  it('reports what it could not read, by line', () => {
    const parsed = parseDotenv('GOOD=1\nnot a line\n1BAD=2\nOPEN="never closed\n');
    expect(parsed.values).toEqual({ GOOD: '1' });
    expect(parsed.problems).toEqual([
      'line 2: not a NAME=value line',
      'line 3: not a NAME=value line',
      'line 4: unterminated quoted value',
    ]);
  });
});
