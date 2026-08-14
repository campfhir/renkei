/**
 * What the detectors find, and — more importantly — what they leave alone.
 *
 * The false-positive suite is the larger half on purpose. A missed identifier
 * is one leak; a detector that rewrites Jira keys, order numbers and release
 * dates produces a gateway whose output nobody trusts, and the response to
 * that is to switch the whole thing off. So every "does not touch" case below
 * is drawn from text these tools actually return.
 */

import { detect, DEFAULT_DETECTORS, LABEL_CARD, LABEL_DOB, LABEL_MRN, LABEL_SSN } from './detect';

const labels = (text: string, detectors = DEFAULT_DETECTORS, mrnPatterns?: string[]) =>
  detect(text, { detectors, ...(mrnPatterns ? { mrnPatterns } : {}) }).map((f) => f.label);

const values = (text: string, detectors = DEFAULT_DETECTORS) =>
  detect(text, { detectors }).map((f) => f.value);

describe('social security numbers', () => {
  it('finds the dashed form', () => {
    expect(values('SSN is 123-45-6789 on file')).toEqual(['123-45-6789']);
  });

  it('finds nine bare digits only when labelled as an SSN', () => {
    expect(values('SSN: 123456789')).toEqual(['123456789']);
    // Nine digits with nothing saying what they are: an order number, a
    // build id, an account. Guessing here is how legitimate data gets eaten.
    expect(labels('Reference 123456789 shipped')).toEqual([]);
  });

  it('ignores ranges the SSA never issues', () => {
    expect(labels('000-12-3456')).toEqual([]);
    expect(labels('666-12-3456')).toEqual([]);
    expect(labels('900-12-3456')).toEqual([]);
    expect(labels('123-00-4567')).toEqual([]);
    expect(labels('123-45-0000')).toEqual([]);
  });

  it('leaves ordinary hyphenated numbers alone', () => {
    // Every one of these appears in real tool output.
    expect(labels('Issue PROJ-1234 is blocked')).toEqual([]);
    expect(labels('Released 2026-08-13 at 14:02')).toEqual([]);
    expect(labels('Invoice 4521-99 for 2026')).toEqual([]);
    expect(labels('Call +1 555-867-5309 for support')).toEqual([]);
  });
});

describe('payment cards', () => {
  it('finds a card that passes Luhn and carries an issuer prefix', () => {
    expect(labels('card 4111 1111 1111 1111 charged')).toEqual([LABEL_CARD]);
    expect(labels('amex 378282246310005')).toEqual([LABEL_CARD]);
    expect(labels('mastercard 5555-5555-5555-4444')).toEqual([LABEL_CARD]);
  });

  it('ignores a number of card length that fails the checksum', () => {
    expect(labels('order 4111111111111112')).toEqual([]);
  });

  it('ignores long identifiers with no issuer prefix', () => {
    // Passes Luhn by luck; is a meeting id, not a card.
    expect(labels('Zoom meeting 9999999999998')).toEqual([]);
    expect(labels('Tracking 1Z999AA10123456784')).toEqual([]);
  });
});

describe('medical record numbers', () => {
  it('finds one behind its label', () => {
    expect(values('MRN: 4417732 admitted')).toEqual(['4417732']);
    expect(labels('Medical Record Number 88213')).toEqual([LABEL_MRN]);
    expect(labels('chart # A-99213')).toEqual([LABEL_MRN]);
  });

  it('replaces the number and keeps the label readable', () => {
    const [finding] = detect('MRN: 4417732', { detectors: ['mrn'] });
    expect(finding?.value).toBe('4417732');
    // The word MRN is outside the span, so the result still says what was
    // removed rather than becoming an opaque blob.
    expect(finding?.start).toBe('MRN: '.length);
  });

  it('never guesses at a bare number', () => {
    // There is no universal MRN format. Anything else is someone's ticket.
    expect(labels('Record 4417732 updated')).toEqual([]);
    expect(labels('Build 8821349')).toEqual([]);
  });

  it('accepts a site-specific pattern the org supplies', () => {
    expect(labels('Account XY-4417732 seen', ['mrn'], ['\\bXY-\\d{7}\\b'])).toEqual([LABEL_MRN]);
  });

  it('survives a malformed org pattern instead of throwing', () => {
    // A typo in a settings row must not take down every tool call.
    expect(() =>
      detect('MRN: 4417732', { detectors: ['mrn'], mrnPatterns: ['([unclosed'] })
    ).not.toThrow();
    expect(labels('MRN: 4417732', ['mrn'], ['([unclosed'])).toEqual([LABEL_MRN]);
  });
});

describe('dates of birth', () => {
  it('finds a date behind a birth label, in several formats', () => {
    expect(labels('DOB: 03/14/1962')).toEqual([LABEL_DOB]);
    expect(labels('date of birth 1962-03-14')).toEqual([LABEL_DOB]);
    expect(labels('D.O.B. 14 Mar 1962')).toEqual([LABEL_DOB]);
    expect(labels('born on March 14, 1962')).toEqual([LABEL_DOB]);
  });

  it('never touches a bare date', () => {
    // Every Jira issue, every mail header, every sprint. Redacting these
    // would make the product useless within one tool call.
    expect(labels('Created 2026-08-13, due 09/01/2026')).toEqual([]);
    expect(labels('Sprint ends March 14, 2026')).toEqual([]);
  });
});

describe('patient names', () => {
  const withNames = (text: string) => detect(text, { detectors: ['patient_name'] });

  it('finds a name behind a patient marker', () => {
    expect(withNames('Patient: John Smith called').map((f) => f.value)).toEqual(['John Smith']);
    expect(withNames('pt Jane A Doe seen today').map((f) => f.value)).toEqual(['Jane A Doe']);
    expect(withNames('Patient Mr. John Smith').map((f) => f.value)).toEqual(['Mr. John Smith']);
  });

  it('leaves colleagues, vendors and customers alone', () => {
    // This is the whole reason the detector is label-scoped. These names are
    // what the tools are for.
    expect(withNames('Assigned to Dana Whitfield')).toEqual([]);
    expect(withNames('Vendor rep Alex Reyes will follow up')).toEqual([]);
    expect(withNames('Reported by Priya Raman, reviewed by Tom Okafor')).toEqual([]);
  });

  it('does not mistake product language for a person', () => {
    // "Patient Portal is down" must not read as a patient called Portal.
    expect(withNames('Patient Portal is down')).toEqual([]);
    expect(withNames('Patient Access team triaged it')).toEqual([]);
    expect(withNames('Patient Safety review scheduled')).toEqual([]);
    expect(withNames('patient records migration')).toEqual([]);
  });

  it('is off unless asked for', () => {
    expect(labels('Patient: John Smith')).toEqual([]);
  });

  it('misses an unlabelled mention, which is the known limit', () => {
    // Documented rather than pretended away: without a marker there is no
    // deterministic way to tell this from a colleague's name.
    expect(withNames('Spoke with Mr. Smith again Tuesday')).toEqual([]);
  });
});

describe('overlaps and repeat passes', () => {
  it('prefers the labelled reading when two detectors claim the same text', () => {
    // The number satisfies Luhn and sits behind an MRN label; it is an MRN.
    const found = detect('MRN: 4111111111111111', { detectors: ['mrn', 'card'] });
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe(LABEL_MRN);
  });

  it('does not re-read text it already replaced', () => {
    // Redaction must be idempotent: a token is not an identifier.
    expect(labels('SSN [SSN-4f3a91b2] on file')).toEqual([]);
    expect(labels('MRN: [MRN-2b91c4de]')).toEqual([]);
  });

  it('returns findings in order and non-overlapping', () => {
    const found = detect('SSN 123-45-6789 and MRN: 4417732 and DOB: 03/14/1962');
    expect(found.map((f) => f.label)).toEqual([LABEL_SSN, LABEL_MRN, LABEL_DOB]);
    for (let i = 1; i < found.length; i += 1) {
      expect(found[i]!.start).toBeGreaterThanOrEqual(found[i - 1]!.end);
    }
  });

  it('finds nothing in ordinary engineering prose', () => {
    // A whole realistic tool result with no PHI in it must come back
    // untouched — the common case, and the one that has to stay cheap.
    const issue = [
      'PROJ-4821: Deploy fails on 2026-08-13 after bumping to 1.2.3',
      'Assigned to Dana Whitfield, reported by Priya Raman.',
      'Error code 500 on 10.0.0.14:8443, build 8821349, retried 3 times.',
      'See https://example.atlassian.net/browse/PROJ-4821 and the 2026-09-01 release.',
    ].join('\n');
    expect(detect(issue)).toEqual([]);
  });
});
