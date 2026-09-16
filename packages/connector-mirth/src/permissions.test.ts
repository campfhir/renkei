import {
  DEFAULT_MIRTH_PERMISSIONS,
  MIRTH_PERMISSIONS,
  MIRTH_PERMISSION_GROUPS,
  MIRTH_PERMISSION_PRESETS,
  isMirthPermission,
  mirthPermission,
  normalizePermissions,
} from './permissions';

describe('the permission catalog', () => {
  it('has unique dotted ids of the form area.verb, each with a label and description', () => {
    const ids = MIRTH_PERMISSIONS.map((permission) => permission.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const permission of MIRTH_PERMISSIONS) {
      expect(permission.id).toMatch(/^[a-z_]+\.[a-z]+$/);
      expect(permission.label.length).toBeGreaterThan(3);
      expect(permission.description.length).toBeGreaterThan(10);
    }
  });

  it('groups in a stable order and offers a read permission per area', () => {
    expect(MIRTH_PERMISSION_GROUPS).toEqual([
      'Channels',
      'Messages',
      'Alerts',
      'Code templates',
      'Users',
      'Events',
      'Server',
    ]);
    for (const group of MIRTH_PERMISSION_GROUPS) {
      const reads = MIRTH_PERMISSIONS.filter((p) => p.group === group && p.id.endsWith('.read'));
      expect({ group, reads: reads.length }).toEqual({ group, reads: 1 });
    }
  });

  it('normalizes unknown values away and keeps catalog order', () => {
    expect(
      normalizePermissions(['messages.send', 'nope', 'channels.read', 'channels.read'])
    ).toEqual(['channels.read', 'messages.send']);
    expect(isMirthPermission('users.delete')).toBe(true);
    expect(isMirthPermission('users.nuke')).toBe(false);
    expect(mirthPermission('channels.deploy').label).toBe('Deploy and control channels');
  });

  it('presets are subsets of the catalog, read-only holds exactly the reads, everything holds all', () => {
    for (const preset of MIRTH_PERMISSION_PRESETS) {
      expect(normalizePermissions(preset.permissions)).toEqual([...preset.permissions]);
    }
    const readOnly = MIRTH_PERMISSION_PRESETS.find((preset) => preset.id === 'read')!;
    expect(readOnly.permissions.every((id) => id.endsWith('.read'))).toBe(true);
    expect(readOnly.permissions).toEqual(DEFAULT_MIRTH_PERMISSIONS);
    const all = MIRTH_PERMISSION_PRESETS.find((preset) => preset.id === 'all')!;
    expect(all.permissions).toHaveLength(MIRTH_PERMISSIONS.length);
    const develop = MIRTH_PERMISSION_PRESETS.find((preset) => preset.id === 'develop')!;
    expect(develop.permissions.some((id) => id.endsWith('.delete'))).toBe(false);
    expect(develop.permissions).not.toContain('server.restore');
  });
});
