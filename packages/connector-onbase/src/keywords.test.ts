import {
  flattenKeywordValues,
  mergeKeywordCollections,
  resolveKeywordTypeRef,
} from './keywords';
import type { OnBaseKeywordCollection, OnBaseKeywordType } from './types';

const CATALOG: OnBaseKeywordType[] = [
  { id: '101', name: 'Vendor', systemName: 'VENDOR NAME', dataType: 'Alphanumeric' },
  { id: '102', name: 'Invoice Amount', systemName: 'INV AMOUNT', dataType: 'Currency' },
  { id: '103', name: 'Amount', systemName: 'AMOUNT', dataType: 'Currency' },
  { id: '104', name: 'amount', systemName: 'LEGACY AMOUNT', dataType: 'Numeric9' },
];

describe('resolveKeywordTypeRef', () => {
  it('returns an exact id match without name matching', () => {
    const result = resolveKeywordTypeRef(CATALOG, '102');
    expect(result).toEqual({ ok: true, val: '102' });
  });

  it('matches names case-insensitively', () => {
    const result = resolveKeywordTypeRef(CATALOG, 'vendor');
    expect(result).toEqual({ ok: true, val: '101' });
  });

  it('matches system names too', () => {
    const result = resolveKeywordTypeRef(CATALOG, 'inv amount');
    expect(result).toEqual({ ok: true, val: '102' });
  });

  it('refuses an ambiguous name and lists the candidates', () => {
    const result = resolveKeywordTypeRef(CATALOG, 'Amount');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.type).toBe('AMBIGUOUS_KEYWORD_TYPE');
      expect(result.err.message).toContain('103');
      expect(result.err.message).toContain('104');
    }
  });

  it('refuses an unknown name and names known types', () => {
    const result = resolveKeywordTypeRef(CATALOG, 'PO Number');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.type).toBe('UNKNOWN_KEYWORD_TYPE');
      expect(result.err.message).toContain('Vendor');
    }
  });
});

const CURRENT: OnBaseKeywordCollection = {
  keywordGuid: 'guid-1',
  items: [
    {
      keywords: [
        { typeId: '101', values: [{ value: 'Acme' }] },
        { typeId: '102', values: [{ value: '100.00' }] },
      ],
    },
    {
      typeGroupId: 'g1',
      groupId: 'i1',
      keywords: [{ typeId: '109', values: [{ value: 'kept' }] }],
    },
  ],
};

describe('mergeKeywordCollections', () => {
  it('replaces only the named type and keeps everything else', () => {
    const result = mergeKeywordCollections(CURRENT, [{ typeId: '102', values: ['250.00'] }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.keywordGuid).toBe('guid-1');
      expect(result.val.items[0].keywords[0].values).toEqual([{ value: 'Acme' }]);
      expect(result.val.items[0].keywords[1].values).toEqual([{ value: '250.00' }]);
      expect(result.val.items[1].keywords[0].values).toEqual([{ value: 'kept' }]);
    }
  });

  it('does not mutate the input collection', () => {
    mergeKeywordCollections(CURRENT, [{ typeId: '102', values: ['999.99'] }]);
    expect(CURRENT.items[0].keywords[1].values).toEqual([{ value: '100.00' }]);
  });

  it('blanks a keyword with an empty value list', () => {
    const result = mergeKeywordCollections(CURRENT, [{ typeId: '101', values: [] }]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.items[0].keywords[0].values).toEqual([]);
  });

  it('appends a type the document does not carry yet', () => {
    const result = mergeKeywordCollections(CURRENT, [{ typeId: '110', values: ['new'] }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.items).toHaveLength(3);
      expect(result.val.items[2]).toEqual({
        keywords: [{ typeId: '110', values: [{ value: 'new' }] }],
      });
    }
  });

  it('refuses a type that appears in multiple group instances', () => {
    const multi: OnBaseKeywordCollection = {
      keywordGuid: 'guid-2',
      items: [
        { typeGroupId: 'g1', groupId: 'a', keywords: [{ typeId: '200', values: [] }] },
        { typeGroupId: 'g1', groupId: 'b', keywords: [{ typeId: '200', values: [] }] },
      ],
    };
    const result = mergeKeywordCollections(multi, [{ typeId: '200', values: ['x'] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.type).toBe('AMBIGUOUS_KEYWORD_GROUP');
  });
});

describe('flattenKeywordValues', () => {
  it('prefers formattedValue and folds duplicate types across groups', () => {
    const flattened = flattenKeywordValues({
      items: [
        { keywords: [{ typeId: '1', values: [{ value: '1.5', formattedValue: '$1.50' }] }] },
        { keywords: [{ typeId: '1', values: [{ value: '2' }] }, { values: [{ value: 'no-type' }] }] },
      ],
    });
    expect(flattened).toEqual([{ typeId: '1', values: ['$1.50', '2'] }]);
  });
});
