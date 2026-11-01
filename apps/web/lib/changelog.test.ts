/**
 * The changelog behind About: every release is headed by its calendar date
 * (what about-changelog-dates.spec.ts read off the page before; the spec
 * keeps only the phone-width fit of those headings).
 */

import { CHANGELOG, releaseDate } from './changelog';

const DATED_HEADING = /^\d{1,2} [A-Z][a-z]+ \d{4}$/;

describe('the About page changelog', () => {
  it('heads every release by a date, never a fallback such as "Unreleased"', () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    for (const release of CHANGELOG) {
      expect(releaseDate(release.date)).toMatch(DATED_HEADING);
      expect(release.heading ?? '').not.toMatch(/unreleased/i);
    }
  });

  it('dates every release with a real ISO calendar day', () => {
    for (const { date } of CHANGELOG) {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(date);
    }
  });

  it('writes a date as day, month name and year, with no timezone shift', () => {
    expect(releaseDate('2026-08-25')).toBe('25 August 2026');
    expect(releaseDate('2026-01-01')).toBe('1 January 2026');
    expect(releaseDate('2026-12-31')).toBe('31 December 2026');
  });

  it('shows a date it cannot read as it was written', () => {
    expect(releaseDate('2026-13-01')).toBe('2026-13-01');
  });
});
