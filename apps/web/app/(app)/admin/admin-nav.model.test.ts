import { adminSections } from '@/lib/admin-areas';
import { SETTINGS_PARTS, currentArea, isAreaList } from './admin-nav.model';

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

  it('names each part of Settings once', () => {
    expect(new Set(SETTINGS_PARTS).size).toBe(SETTINGS_PARTS.length);
  });
});
