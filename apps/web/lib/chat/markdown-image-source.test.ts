import { classifyImageSource } from './markdown-image-source';

describe('classifyImageSource', () => {
  it.each([
    '/api/chat/chats/1/files/chart.png',
    'data:image/png;base64,AAAA',
    'DATA:IMAGE/PNG;base64,AAAA',
    'blob:https://renkei.example/7c0b',
  ])('loads %s by itself', (src) => {
    expect(classifyImageSource(src)).toEqual({ trusted: true });
  });

  it.each([
    ['https://attacker.example/p?d=secret', 'attacker.example'],
    ['http://attacker.example/p', 'attacker.example'],
    ['//attacker.example/p', 'attacker.example'],
    ['/\\attacker.example/p', 'attacker.example'],
    ['data:text/html,<script>', 'another site'],
  ])('holds %s back', (src, host) => {
    const verdict = classifyImageSource(src);
    expect(verdict.trusted).toBe(false);
    if (!verdict.trusted) expect(verdict.host).toBe(host);
  });

  it('holds back a missing or unparseable source', () => {
    expect(classifyImageSource(undefined).trusted).toBe(false);
    expect(classifyImageSource('').trusted).toBe(false);
    expect(classifyImageSource('relative.png')).toEqual({ trusted: false, host: 'another site' });
  });
});
