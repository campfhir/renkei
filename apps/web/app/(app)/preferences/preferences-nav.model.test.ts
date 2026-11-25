import {
  NOTIFICATION_CARDS,
  PREFERENCES_GROUPS,
  PREFERENCES_SECTIONS,
  currentSection,
  isSectionList,
  sectionHref,
  sectionSummaries,
} from './preferences-nav.model';

describe('Preferences’ sections', () => {
  it('lists every section once, in four groups, each with its own page', () => {
    expect(PREFERENCES_GROUPS.map((group) => group.label)).toEqual([
      'General',
      'Tools & automation',
      'Notifications',
      'Account',
    ]);
    const ids = PREFERENCES_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sectionHref('agents')).toBe('/preferences/agents');
  });

  it('knows which section a path is in, including a page under a section', () => {
    expect(currentSection('/preferences/agents')).toBe('agents');
    expect(currentSection('/preferences/data/')).toBe('data');
    expect(currentSection('/preferences/data/export')).toBe('data');
    expect(currentSection('/preferences')).toBeNull();
    expect(currentSection('/preferences/nonsense')).toBeNull();
    expect(currentSection('/preferencesx/agents')).toBeNull();
  });

  it('the section list is /preferences itself, and nothing under it', () => {
    expect(isSectionList('/preferences')).toBe(true);
    expect(isSectionList('/preferences/')).toBe(true);
    expect(isSectionList('/preferences/agents')).toBe(false);
  });

  it('names each notification card it links to once', () => {
    const ids = NOTIFICATION_CARDS.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the overview says where each section stands, and a blurb where there is nothing to say', () => {
    const fresh = sectionSummaries({
      theme: { mode: 'auto', codeLineNumbers: false },
      archiveAfterDays: null,
      permissions: { allowed: 0, blocked: 0 },
      agentsAllowing: 0,
      codeChanges: 0,
    });
    expect(fresh.appearance).toBe('Matches your system');
    expect(fresh.chats).toBe('Never archived automatically');
    expect(fresh.permissions).toBe('Everything that acts asks first');
    expect(fresh.agents).toBe('Every agent’s changes wait for you');
    expect(fresh.code).toBe('Auto mode asks before anything outside the checkout');
    expect(fresh.notifications).toBe('What reaches you, and where');

    const set = sectionSummaries({
      theme: { mode: 'dark', codeLineNumbers: true },
      archiveAfterDays: 1,
      permissions: { allowed: 2, blocked: 1 },
      agentsAllowing: 3,
      codeChanges: 1,
    });
    expect(set.appearance).toBe('Dark · line numbers on');
    expect(set.chats).toBe('Archived after 1 day unused');
    expect(set.permissions).toBe('2 allowed, 1 blocked');
    expect(set.agents).toBe('3 agents run some actions without asking');
    expect(
      sectionSummaries({
        theme: { mode: 'auto', codeLineNumbers: false },
        archiveAfterDays: null,
        permissions: { allowed: 0, blocked: 0 },
        agentsAllowing: 1,
        codeChanges: 0,
      }).agents
    ).toBe('1 agent runs some actions without asking');
    expect(set.code).toBe('Auto mode: 1 tool changed from the default');
  });
});
