/**
 * The disclosure gate's contract: deterministic policy evaluation,
 * most-restrictive-wins across labels, unknown labels blocked, and the
 * unlabeled case an explicit org choice. These tests are the gate's spec.
 */

import { evaluateDisclosure, moreRestrictive } from './disclosure';
import type { DisclosurePolicy } from './disclosure';

const policy: DisclosurePolicy = {
  rules: [
    { label: 'internal', decision: 'allow' },
    { label: 'pii', decision: 'anonymize' },
    { label: 'nda-covered', decision: 'allow' },
    // NDA content may circulate internally but must not reach an external
    // model API — the channel-specific rule overrides for that channel.
    { label: 'nda-covered', channel: 'model-api', decision: 'block' },
    { label: 'patient-information', decision: 'escalate' },
  ],
  unlabeled: 'allow',
};

describe('evaluateDisclosure', () => {
  it('applies the label rule for the channel', () => {
    expect(evaluateDisclosure(['internal'], 'email', policy)).toEqual({
      decision: 'allow',
      decidingLabel: 'internal',
    });
  });

  it('lets a channel-specific rule override the general rule', () => {
    expect(evaluateDisclosure(['nda-covered'], 'email', policy).decision).toBe('allow');
    expect(evaluateDisclosure(['nda-covered'], 'model-api', policy).decision).toBe('block');
  });

  it('resolves multiple labels to the most restrictive decision', () => {
    const verdict = evaluateDisclosure(['internal', 'pii'], 'email', policy);
    expect(verdict.decision).toBe('anonymize');
    expect(verdict.decidingLabel).toBe('pii');
  });

  it('blocks a label the policy does not know', () => {
    const verdict = evaluateDisclosure(['internal', 'never-defined'], 'email', policy);
    expect(verdict.decision).toBe('block');
    expect(verdict.decidingLabel).toBe('never-defined');
  });

  it('uses the explicit unlabeled decision for content with no labels', () => {
    expect(evaluateDisclosure([], 'email', policy)).toEqual({
      decision: 'allow',
      decidingLabel: null,
    });
    expect(evaluateDisclosure([], 'email', { ...policy, unlabeled: 'block' }).decision).toBe(
      'block'
    );
  });

  it('ranks block above escalate: a final no beats a human maybe', () => {
    expect(moreRestrictive('escalate', 'block')).toBe('block');
    const verdict = evaluateDisclosure(['patient-information', 'never-defined'], 'email', policy);
    expect(verdict.decision).toBe('block');
  });
});
