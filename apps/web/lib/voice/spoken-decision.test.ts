import { spokenDecision } from './spoken-decision';

describe('spokenDecision', () => {
  it('hears the three answers, however they are put', () => {
    expect(spokenDecision('Allow.')).toBe('once');
    expect(spokenDecision('yes go ahead')).toBe('once');
    expect(spokenDecision('Always allow')).toBe('always');
    expect(spokenDecision('allow it always')).toBe('always');
    expect(spokenDecision('Deny')).toBe('deny');
    expect(spokenDecision("No, don't do that")).toBe('deny');
  });

  it('lets a no win over a yes, and always over allow', () => {
    expect(spokenDecision('no, do not allow')).toBe('deny');
    expect(spokenDecision('always allow, yes')).toBe('always');
    expect(spokenDecision('no, always allow it')).toBe('deny');
  });

  it('is null for anything else', () => {
    expect(spokenDecision('what is it going to send')).toBeNull();
    expect(spokenDecision('')).toBeNull();
  });
});
