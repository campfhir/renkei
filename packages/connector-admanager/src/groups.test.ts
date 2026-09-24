import { dedupeGroupNames, groupNamesFromDns, groupsPresent, groupsToAdd } from './groups';

describe('groupNamesFromDns', () => {
  it('extracts the CN from each distinguished name', () => {
    expect(
      groupNamesFromDns([
        'CN=Finance-ReadOnly,OU=Groups,DC=corp,DC=example',
        'CN=VPN Users,OU=Groups,DC=corp,DC=example',
      ])
    ).toEqual(['Finance-ReadOnly', 'VPN Users']);
  });

  it('un-escapes a backslash-escaped comma inside the CN', () => {
    expect(groupNamesFromDns(['CN=Smith\\, Jane Group,OU=Groups,DC=corp,DC=example'])).toEqual([
      'Smith, Jane Group',
    ]);
  });

  it('drops entries that are not strings or do not start with CN=', () => {
    expect(groupNamesFromDns([42, null, 'OU=Groups,DC=corp,DC=example', ''])).toEqual([]);
  });
});

describe('dedupeGroupNames', () => {
  it('folds case-insensitive duplicates, keeping the first-seen casing', () => {
    expect(dedupeGroupNames(['Finance-ReadOnly', 'finance-readonly', 'VPN Users'])).toEqual([
      'Finance-ReadOnly',
      'VPN Users',
    ]);
  });

  it('drops blank entries', () => {
    expect(dedupeGroupNames(['', '  ', 'VPN Users'])).toEqual(['VPN Users']);
  });
});

describe('groupsToAdd', () => {
  it('is every source group the target does not already have', () => {
    expect(groupsToAdd(['Finance-ReadOnly', 'VPN Users'], ['VPN Users'])).toEqual([
      'Finance-ReadOnly',
    ]);
  });

  it('matches case-insensitively and never suggests removing anything', () => {
    expect(groupsToAdd(['vpn users'], ['VPN Users'])).toEqual([]);
    expect(groupsToAdd([], ['VPN Users', 'Finance-ReadOnly'])).toEqual([]);
  });

  it('is empty when the target already has every source group', () => {
    expect(groupsToAdd(['VPN Users'], ['VPN Users', 'Finance-ReadOnly'])).toEqual([]);
  });
});

describe('groupsPresent', () => {
  it('keeps only requested groups the user actually has, case-insensitively', () => {
    expect(groupsPresent(['VPN Users', 'Nope'], ['vpn users', 'Finance-ReadOnly'])).toEqual([
      'VPN Users',
    ]);
  });
});
