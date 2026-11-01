import { asRecord, isRecord, isString, recordOrNull } from './index';

class Point {
  x = 1;
}

describe('isRecord', () => {
  it('is true for objects whose fields can be read by name', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ id: 'a' })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Point())).toBe(true);
  });

  it('is false for null, arrays and every primitive', () => {
    for (const value of [null, undefined, [], [1], 'a', 0, true, Symbol('s'), () => 1]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

describe('asRecord', () => {
  it('hands back the record itself, not a copy', () => {
    const body = { id: 'a' };
    expect(asRecord(body)).toBe(body);
  });

  it('reads anything else as an empty record', () => {
    for (const value of [null, undefined, ['a'], 'a', 3]) expect(asRecord(value)).toEqual({});
  });
});

describe('recordOrNull', () => {
  it('tells a missing or wrong-shaped value apart from an empty record', () => {
    expect(recordOrNull({})).toEqual({});
    expect(recordOrNull([])).toBeNull();
    expect(recordOrNull(undefined)).toBeNull();
  });
});

describe('isString', () => {
  it('narrows a mixed array to its strings, empty ones included', () => {
    expect(['a', 1, '', null, 'b'].filter(isString)).toEqual(['a', '', 'b']);
  });
});
