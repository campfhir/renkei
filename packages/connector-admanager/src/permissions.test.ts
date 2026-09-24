import {
  ADMANAGER_PERMISSION_IDS,
  ADMANAGER_PERMISSION_PRESETS,
  DEFAULT_ADMANAGER_PERMISSIONS,
  admanagerPermission,
  isAdManagerPermission,
  normalizePermissions,
  type AdManagerPermission,
} from './permissions';

function unknownPermission(): AdManagerPermission {
  // A runtime-invalid id, produced without an `as` assertion: JSON.parse
  // returns `any`, which satisfies this function's declared return type
  // without a cast.
  return JSON.parse('"nope"');
}

describe('isAdManagerPermission', () => {
  it('accepts known ids and refuses everything else', () => {
    expect(isAdManagerPermission('accounts.read')).toBe(true);
    expect(isAdManagerPermission('accounts.unlock')).toBe(true);
    expect(isAdManagerPermission('groups.modify')).toBe(true);
    expect(isAdManagerPermission('accounts.delete')).toBe(false);
    expect(isAdManagerPermission('')).toBe(false);
    expect(isAdManagerPermission(42)).toBe(false);
  });
});

describe('admanagerPermission', () => {
  it('returns the catalog entry and throws on an unknown id', () => {
    expect(admanagerPermission('accounts.unlock').label).toBe('Unlock accounts');
    expect(() => admanagerPermission(unknownPermission())).toThrow();
  });
});

describe('normalizePermissions', () => {
  it('drops unknown values, folds duplicates, and keeps catalog order', () => {
    expect(
      normalizePermissions(['groups.modify', 'accounts.read', 'bogus', 'accounts.read'])
    ).toEqual(['accounts.read', 'groups.modify']);
  });

  it('returns empty for no valid values', () => {
    expect(normalizePermissions(['nope', 42, null])).toEqual([]);
  });
});

describe('presets', () => {
  it('every preset only names real permissions', () => {
    for (const preset of ADMANAGER_PERMISSION_PRESETS) {
      for (const id of preset.permissions) {
        expect(ADMANAGER_PERMISSION_IDS).toContain(id);
      }
    }
  });

  it('the "all" preset is exactly every permission', () => {
    const all = ADMANAGER_PERMISSION_PRESETS.find((preset) => preset.id === 'all');
    expect(all?.permissions).toEqual(ADMANAGER_PERMISSION_IDS);
  });

  it('the read preset is exactly the default', () => {
    const read = ADMANAGER_PERMISSION_PRESETS.find((preset) => preset.id === 'read');
    expect(read?.permissions).toEqual(DEFAULT_ADMANAGER_PERMISSIONS);
  });
});
