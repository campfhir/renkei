import {
  checkPermissionSetName,
  impliedRights,
  permissionSetFile,
  rightsLabel,
  mergePermissionSetAccess,
  permissionSetGrantCounts,
  unionRights,
  withoutRights,
} from './permission-sets';

describe('impliedRights', () => {
  it('adds what each right needs, the way Setup ticks them', () => {
    expect(impliedRights({ edit: true })).toEqual({
      read: true,
      create: false,
      edit: true,
      delete: false,
      viewAll: false,
      modifyAll: false,
    });
    expect(rightsLabel(impliedRights({ delete: true }))).toBe('read, edit, delete');
    expect(rightsLabel(impliedRights({ modifyAll: true }))).toBe(
      'read, create, edit, delete, view all, modify all'
    );
    expect(rightsLabel(impliedRights({}))).toBe('none');
  });

  it('never takes a right away when access is added', () => {
    const had = impliedRights({ delete: true });
    expect(rightsLabel(unionRights(had, impliedRights({ create: true })))).toBe(
      'read, create, edit, delete'
    );
  });
});

describe('checkPermissionSetName', () => {
  it('derives the API name from the label and refuses one that is taken', () => {
    expect(checkPermissionSetName({ label: 'Site Visits (edit)' }, [])).toEqual({
      ok: true,
      name: 'Site_Visits_edit',
      label: 'Site Visits (edit)',
    });
    const taken = checkPermissionSetName({ label: 'Site Visits' }, [
      { name: 'Site_Visits', label: 'Other' },
    ]);
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.errors[0]).toContain('already a permission set Site_Visits');
    expect(checkPermissionSetName({ label: 'x', name: '1bad' }, []).ok).toBe(false);
  });
});

describe('permissionSetFile', () => {
  it('writes the set with its object, field and tab access', () => {
    const xml = permissionSetFile({
      name: 'Site_Visits',
      label: 'Site Visits & more',
      objects: [{ object: 'Site_Visit__c', ...impliedRights({ edit: true }) }],
      fields: [{ field: 'Site_Visit__c.Outcome__c', edit: false }],
      tabs: ['Site_Visit__c'],
    });
    expect(xml).toContain('<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(xml).toContain('<label>Site Visits &amp; more</label>');
    expect(xml).toContain('<allowEdit>true</allowEdit>');
    expect(xml).toContain('<object>Site_Visit__c</object>');
    expect(xml).toContain('<field>Site_Visit__c.Outcome__c</field>');
    expect(xml).toContain('<editable>false</editable>');
    expect(xml).toContain('<tab>Site_Visit__c</tab>');
    expect(xml).toContain('<visibility>Visible</visibility>');
    expect(xml).not.toContain('<description>');
  });
});

describe('withoutRights', () => {
  const all = impliedRights({ modifyAll: true });

  it('takes what stands on a right away with it', () => {
    expect(rightsLabel(withoutRights(all, ['edit']))).toBe('read, create, view all');
    expect(rightsLabel(withoutRights(all, ['viewAll']))).toBe('read, create, edit, delete');
    expect(rightsLabel(withoutRights(all, ['modifyAll']))).toBe(
      'read, create, edit, delete, view all'
    );
  });

  it('leaves nothing without read, and what was there when nothing named is held', () => {
    expect(rightsLabel(withoutRights(all, ['read']))).toBe('none');
    const reader = impliedRights({ read: true });
    expect(withoutRights(reader, ['delete'])).toEqual(reader);
  });
});

describe('mergePermissionSetAccess', () => {
  // As readMetadata gives it: one entry alone is an object, values are strings.
  const set = {
    label: 'Program Staff',
    fieldPermissions: { editable: 'true', field: 'Visit__c.Stage__c', readable: 'true' },
    objectPermissions: [
      { allowRead: 'true', allowEdit: 'true', object: 'Visit__c' },
      { allowRead: 'true', object: 'Account' },
    ],
    userPermissions: { enabled: 'true', name: 'ViewSetup' },
  };

  it('adds field access beside what is there, and leaves everything not named as read', () => {
    const next = mergePermissionSetAccess(set, {
      fields: [{ field: 'Visit__c.Years__c', access: { read: true, edit: false } }],
    });
    expect(next.fieldPermissions).toEqual([
      set.fieldPermissions,
      { editable: false, field: 'Visit__c.Years__c', readable: true },
    ]);
    expect(next.objectPermissions).toBe(set.objectPermissions);
    expect(next.userPermissions).toBe(set.userPermissions);
    expect(next.label).toBe('Program Staff');
  });

  it('replaces an entry it changes, and drops one whose access is taken away', () => {
    const next = mergePermissionSetAccess(set, {
      fields: [{ field: 'visit__c.stage__c', access: null }],
      objects: [
        { object: 'Account', rights: null },
        { object: 'Visit__c', rights: impliedRights({ read: true }) },
      ],
      tabs: [{ tab: 'Visit__c', shown: true }],
      recordTypes: ['Visit__c.Home'],
    });
    expect(next.fieldPermissions).toEqual([]);
    expect(next.objectPermissions).toEqual([
      expect.objectContaining({ object: 'Visit__c', allowRead: true, allowEdit: false }),
    ]);
    expect(next.tabSettings).toEqual([{ tab: 'Visit__c', visibility: 'Visible' }]);
    expect(next.recordTypeVisibilities).toEqual([{ recordType: 'Visit__c.Home', visible: true }]);
  });

  it('counts what a whole definition grants', () => {
    expect(permissionSetGrantCounts(set)).toEqual({ fields: 1, objects: 2 });
    expect(permissionSetGrantCounts({})).toEqual({ fields: 0, objects: 0 });
  });
});
