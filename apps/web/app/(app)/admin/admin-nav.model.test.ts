import { adminSections } from '@/lib/admin-areas';
import {
  SETTINGS_GROUPS,
  backLink,
  currentArea,
  currentSettingsGroup,
  isAreaList,
  settingsGroup,
  settingsGroupHref,
  settingsGroupOf,
} from './admin-nav.model';

describe('The Organization console’s areas', () => {
  it('lists every area once, in six groups, each with its own page', () => {
    const sections = adminSections();
    expect(sections.map((section) => section.label)).toEqual([
      'Connections',
      'Agents',
      'Code projects',
      'Usage',
      'Data and policy',
      'People and records',
    ]);
    const hrefs = sections.flatMap((section) => section.areas.map((area) => area.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.every((href) => href.startsWith('/admin/'))).toBe(true);
  });

  it('knows which area a path is in, including a page under an area', () => {
    expect(currentArea('/admin/settings')).toBe('/admin/settings');
    expect(currentArea('/admin/settings/')).toBe('/admin/settings');
    expect(currentArea('/admin/agents/abc/runs/def')).toBe('/admin/agents');
    expect(currentArea('/admin')).toBeNull();
    expect(currentArea('/admin/nonsense')).toBeNull();
    expect(currentArea('/adminx/settings')).toBeNull();
  });

  it('an area is not mistaken for another whose name starts the same', () => {
    expect(currentArea('/admin/ci-blocks/new')).toBe('/admin/ci-blocks');
    expect(currentArea('/admin/ci-targets')).toBe('/admin/ci-targets');
    expect(currentArea('/admin/agents-extra')).toBeNull();
  });

  it('a page an area leads to keeps that area marked', () => {
    expect(currentArea('/admin/mcp')).toBe('/admin/connectors');
    expect(currentArea('/admin/admanager/some-instance')).toBe('/admin/connectors');
    expect(currentArea('/admin/grants')).toBe('/admin/access');
  });

  it('the area list is /admin itself, and nothing under it', () => {
    expect(isAreaList('/admin')).toBe(true);
    expect(isAreaList('/admin/')).toBe(true);
    expect(isAreaList('/admin/settings')).toBe(false);
  });
});

describe('Settings’ groups', () => {
  it('lists six groups, each with its own page', () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual([
      'General',
      'Safety',
      'Agents',
      'Data & search',
      'Access & limits',
      'Sandbox & code',
    ]);
    expect(settingsGroupHref('safety')).toBe('/admin/settings/safety');
    expect(settingsGroup('safety')?.label).toBe('Safety');
    expect(settingsGroup('nonsense')).toBeNull();
  });

  it('every heading is on one group’s page and no other', () => {
    const headings = SETTINGS_GROUPS.flatMap((group) => [...group.parts, ...group.also]);
    expect(new Set(headings).size).toBe(headings.length);
    expect(headings).toHaveLength(14);
  });

  it('finds the page a heading is on, the form’s or one beside it', () => {
    expect(settingsGroupOf('Request limits')?.id).toBe('access');
    expect(settingsGroupOf('Locked high-risk tools')?.id).toBe('safety');
    expect(settingsGroupOf('Identity')?.id).toBe('general');
    expect(settingsGroupOf('Nothing')).toBeNull();
  });

  it('knows which group a path is in, and still marks Settings as the area', () => {
    expect(currentSettingsGroup('/admin/settings/sandbox')).toBe('sandbox');
    expect(currentSettingsGroup('/admin/settings/sandbox/')).toBe('sandbox');
    expect(currentSettingsGroup('/admin/settings')).toBeNull();
    expect(currentSettingsGroup('/admin/settings/nonsense')).toBeNull();
    expect(currentSettingsGroup('/admin/agents')).toBeNull();
    expect(currentArea('/admin/settings/sandbox')).toBe('/admin/settings');
  });

  it('a phone’s link back: a group to Settings, an area to the list, the list nowhere', () => {
    expect(backLink('/admin/settings/safety')).toEqual({
      href: '/admin/settings',
      label: 'Settings',
    });
    expect(backLink('/admin/settings')).toEqual({ href: '/admin', label: 'Organization' });
    expect(backLink('/admin/agents/abc')).toEqual({ href: '/admin', label: 'Organization' });
    expect(backLink('/admin')).toBeNull();
  });
});
