import {
  checkPermissionSetName,
  impliedRights,
  permissionSetFile,
  rightsLabel,
  unionRights,
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
