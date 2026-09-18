import { safeReturnPath } from './return-path';

describe('safeReturnPath', () => {
  it('keeps a same-origin path, query and all', () => {
    expect(safeReturnPath('/acme')).toBe('/acme');
    expect(safeReturnPath('/acme/agents/123/runs?archived=1')).toBe(
      '/acme/agents/123/runs?archived=1'
    );
    expect(safeReturnPath('/')).toBe('/');
  });

  it('rejects anything that could leave the origin', () => {
    expect(safeReturnPath('https://evil.example/acme')).toBeNull();
    expect(safeReturnPath('//evil.example/acme')).toBeNull();
    expect(safeReturnPath('/\\evil.example/acme')).toBeNull();
    expect(safeReturnPath('javascript:alert(1)')).toBeNull();
    expect(safeReturnPath('acme')).toBeNull();
  });

  it('treats nothing as nothing', () => {
    expect(safeReturnPath('')).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
  });
});
