/**
 * Data-driven tests: each JSON file under a stage's fixture directory is one
 * input/output pair. Adding a new fixture case never touches this file.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeBody } from '../clean/generic';
import { classify } from '../classify';
import type { ClassifiableEmail } from '../classify';
import { deriveTemplate, matchTemplate } from '../registry/template';
import type { ClassifierRule, TemplateSegment } from '../types';

function loadFixtures<T>(dir: string): Array<T & { __file: string }> {
  const full = join(__dirname, dir);
  return readdirSync(full)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ ...JSON.parse(readFileSync(join(full, f), 'utf8')), __file: f }));
}

// Only the DECODING cases remain here. The heuristic fixtures (banners,
// quoted chains, the signature delimiter, legal footers) went with the
// heuristics themselves — they describe behaviour a tenant now owns in a
// script, and a fixture asserting the package still does it would be
// asserting the opposite of the design.
describe('generic-clean fixtures', () => {
  for (const fixture of loadFixtures<{ description: string; content: string; expected: string }>(
    'generic-clean'
  )) {
    it(`${fixture.__file}: ${fixture.description}`, () => {
      expect(decodeBody(fixture.content)).toBe(fixture.expected);
    });
  }
});

describe('classify fixtures', () => {
  for (const fixture of loadFixtures<{
    description: string;
    rules: ClassifierRule[];
    email: ClassifiableEmail;
    expected: { category: string; matchedRuleId: string | null; senderKey: string | null };
  }>('classify')) {
    it(`${fixture.__file}: ${fixture.description}`, () => {
      expect(classify(fixture.rules, fixture.email)).toEqual(fixture.expected);
    });
  }
});

describe('registry/template fixtures', () => {
  for (const fixture of loadFixtures<{
    description: string;
    segments: TemplateSegment[];
    matchThreshold: number;
    sample: string;
    expectedFields?: Record<string, string>;
    expectMinScore?: number;
    expectBelowThreshold?: boolean;
  }>('templates')) {
    it(`${fixture.__file}: ${fixture.description}`, () => {
      const match = matchTemplate(fixture.segments, fixture.sample);
      if (fixture.expectBelowThreshold) {
        expect(match.score).toBeLessThan(fixture.matchThreshold);
      } else {
        expect(match.score).toBeGreaterThanOrEqual(
          fixture.expectMinScore ?? fixture.matchThreshold
        );
        if (fixture.expectedFields) expect(match.fields).toEqual(fixture.expectedFields);
      }
    });
  }
});

describe('deriveTemplate → matchTemplate round trip', () => {
  it('a template derived from a marked sample matches that same sample at score 1', () => {
    const sample = 'Alice Chen commented on OPS-42: Deploy looks stable. View Issue now.';
    const segments = deriveTemplate(sample, [
      { name: 'actor', start: 0, end: sample.indexOf(' commented on') },
      {
        name: 'issueKey',
        start: sample.indexOf('OPS-42'),
        end: sample.indexOf('OPS-42') + 'OPS-42'.length,
        pattern: '[A-Z]+-\\d+',
      },
    ]);

    const match = matchTemplate(segments, sample);
    expect(match.score).toBe(1);
    expect(match.fields.actor).toBe('Alice Chen');
    expect(match.fields.issueKey).toBe('OPS-42');
  });

  it('a restyled version of the same sender scores below a strict threshold', () => {
    const sample = 'Alice Chen commented on OPS-42: Deploy looks stable. View Issue now.';
    const segments = deriveTemplate(sample, [
      { name: 'actor', start: 0, end: sample.indexOf(' commented on') },
    ]);
    const restyled = 'Update from Alice Chen on ticket OPS-42 — deploy is stable.';
    const match = matchTemplate(segments, restyled);
    expect(match.score).toBeLessThan(1);
  });
});
