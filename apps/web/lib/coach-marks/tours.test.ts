import { COACH_ANCHORS, coachAnchor, coachSelector, isCoachAnchor } from './anchors';
import { everyTargetKnown } from './progress';
import { COACH_MARK_TOURS, tourById } from './tours';

/**
 * The registry is product copy checked in as code; this is what keeps it
 * honest. A tour with a duplicate id would share a progress row with
 * another; a step pointing at an anchor nothing carries would show a
 * centred card where a spotlight was meant; a version of 0 would never
 * outrank a stored row.
 */
describe('the tour registry', () => {
  it('has at least the welcome tour, first, pinned to the home feed', () => {
    expect(COACH_MARK_TOURS[0]?.id).toBe('welcome');
    expect(COACH_MARK_TOURS[0]?.autoStart).toBe(true);
    expect(COACH_MARK_TOURS[0]?.requires).toEqual(['home-feed']);
  });

  it('gives every tour a unique id fit for a column and a URL', () => {
    const ids = COACH_MARK_TOURS.map((tour) => tour.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  });

  it('gives every tour a version of at least 1 and at least one step', () => {
    for (const tour of COACH_MARK_TOURS) {
      expect(tour.version).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(tour.version)).toBe(true);
      expect(tour.steps.length).toBeGreaterThan(0);
      expect(tour.title.trim()).not.toBe('');
      expect(tour.description.trim()).not.toBe('');
    }
  });

  it('pins every auto-start tour to at least one anchor, all of them known', () => {
    for (const tour of COACH_MARK_TOURS) {
      expect(tour.startPath.startsWith('/')).toBe(true);
      // A tour that requires nothing belongs on every page; one that starts
      // unasked must say where it belongs, or it would greet every visit.
      if (tour.autoStart) expect(tour.requires?.length ?? 0).toBeGreaterThan(0);
      expect(everyTargetKnown(tour.requires ?? [])).toBe(true);
    }
  });

  it('keeps step ids unique within a tour, and every target a known anchor', () => {
    for (const tour of COACH_MARK_TOURS) {
      const ids = tour.steps.map((step) => step.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(everyTargetKnown(tour.steps.map((step) => step.target))).toBe(true);
      for (const step of tour.steps) {
        expect(step.title.trim()).not.toBe('');
        expect(step.body.trim()).not.toBe('');
        if (step.path) expect(step.path.startsWith('/')).toBe(true);
      }
    }
  });

  it('pins the chat tour to the composer, so it belongs on a thread and nowhere else', () => {
    const chat = tourById('chat');
    expect(chat).not.toBeNull();
    expect(chat?.requires).toEqual(['chat-composer']);
    expect(chat?.matches).toBeUndefined();
  });

  it('looks a tour up by id, and nothing else', () => {
    expect(tourById('welcome')?.title).toBe('Welcome to Renkei');
    expect(tourById('nope')).toBeNull();
  });
});

describe('anchors', () => {
  it('are unique and kebab-case', () => {
    expect(new Set(COACH_ANCHORS).size).toBe(COACH_ANCHORS.length);
    for (const anchor of COACH_ANCHORS) expect(anchor).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('spread as a data attribute the selector finds', () => {
    expect(coachAnchor('nav-account')).toEqual({ 'data-coach': 'nav-account' });
    expect(coachSelector('nav-account')).toBe('[data-coach="nav-account"]');
    expect(isCoachAnchor('nav-account')).toBe(true);
    expect(isCoachAnchor('nav-accounts')).toBe(false);
    expect(isCoachAnchor(3)).toBe(false);
  });
});
