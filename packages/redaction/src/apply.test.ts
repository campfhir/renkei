/**
 * Turning findings into text.
 *
 * Two properties carry the feature. Determinism — the same identifier always
 * becomes the same token, so a model can still tell that two tickets concern
 * one record. And containment — the token must not leak the value, must not
 * be stable across tenants, and must survive a second pass unchanged.
 */

import { createPseudonymizer, deriveRedactionKey } from './pseudonym';
import { redactText } from './apply';
import { DEFAULT_MCP_POLICY } from './policy';
import { LABEL_MRN, LABEL_SSN } from './detect';
import type { DisclosurePolicy } from '@renkei/gates';

const key = deriveRedactionKey(Buffer.from('a'.repeat(32)));
const opts = (tenant = 'tenant-1', policy: DisclosurePolicy = DEFAULT_MCP_POLICY) => ({
  policy,
  pseudonymizer: createPseudonymizer(key, tenant),
});

describe('redactText', () => {
  it('replaces an identifier with a stable token and leaves the prose', () => {
    const result = redactText('Member SSN 123-45-6789 verified by phone.', opts());
    expect(result.text).toMatch(/^Member SSN \[SSN-[0-9a-f]{8}\] verified by phone\.$/);
    expect(result.text).not.toContain('123-45-6789');
    expect(result.counts).toEqual({ [LABEL_SSN]: 1 });
  });

  it('gives one identifier the same token everywhere it appears', () => {
    // This is what lets a model still say "these are the same person".
    const result = redactText('MRN: 4417732 today; earlier MRN: 4417732 too.', opts());
    const tokens = [...result.text.matchAll(/\[MRN-[0-9a-f]{8}\]/g)].map((m) => m[0]);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
  });

  it('ignores formatting differences in the same identifier', () => {
    const dashed = redactText('SSN 123-45-6789', opts()).text;
    const bare = redactText('SSN: 123456789', opts()).text;
    const token = /\[SSN-[0-9a-f]{8}\]/;
    expect(dashed.match(token)?.[0]).toBe(bare.match(token)?.[0]);
  });

  it('gives different identifiers different tokens', () => {
    const result = redactText('MRN: 4417732 and MRN: 8899001', opts());
    const tokens = [...result.text.matchAll(/\[MRN-[0-9a-f]{8}\]/g)].map((m) => m[0]);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('does not produce the same token in two tenants', () => {
    // One org's tokens must not be a lookup table for another's.
    const a = redactText('MRN: 4417732', opts('tenant-a')).text;
    const b = redactText('MRN: 4417732', opts('tenant-b')).text;
    expect(a).not.toBe(b);
  });

  it('leaves text with nothing to find exactly as it was', () => {
    const prose = 'PROJ-4821 deployed 2026-08-13 by Dana Whitfield. Build 8821349.';
    const result = redactText(prose, opts());
    expect(result.text).toBe(prose);
    expect(result.counts).toEqual({});
  });

  it('is idempotent', () => {
    // A second pass over redacted text must be a no-op, not a pseudonym of a
    // pseudonym — results get re-read by summarizers and re-rendered.
    const once = redactText('SSN 123-45-6789, MRN: 4417732', opts()).text;
    const twice = redactText(once, opts()).text;
    expect(twice).toBe(once);
  });

  it('handles several identifiers on one line without shifting offsets', () => {
    const result = redactText('Patient MRN: 4417732, DOB: 03/14/1962, SSN 123-45-6789.', opts());
    expect(result.text).not.toMatch(/4417732|03\/14\/1962|123-45-6789/);
    expect(result.text.startsWith('Patient MRN: [')).toBe(true);
    expect(result.text.endsWith('].')).toBe(true);
  });
});

describe('policy decisions', () => {
  const policyFor = (
    decision: DisclosurePolicy['rules'][number]['decision']
  ): DisclosurePolicy => ({
    rules: [{ label: LABEL_SSN, decision }],
    unlabeled: 'allow',
  });

  it('allow leaves the value untouched', () => {
    const result = redactText('SSN 123-45-6789', opts('t', policyFor('allow')));
    expect(result.text).toBe('SSN 123-45-6789');
    expect(result.counts).toEqual({});
  });

  it('redact masks but keeps a tail to reconcile against', () => {
    const result = redactText('SSN 123-45-6789', opts('t', policyFor('redact')));
    expect(result.text).toContain('6789');
    expect(result.text).not.toContain('123-45');
  });

  it('anonymize keeps linkage and drops the value', () => {
    const result = redactText('SSN 123-45-6789', opts('t', policyFor('anonymize')));
    expect(result.text).toMatch(/\[SSN-[0-9a-f]{8}\]/);
    expect(result.text).not.toContain('6789');
  });

  it('block strikes the value with no linkage at all', () => {
    // There is no way to halt a tool call here, so block becomes the
    // strongest edit available to a span: nothing left, not even a token to
    // correlate on. Stricter than anonymize, so nothing is weakened.
    const result = redactText('SSN 123-45-6789', opts('t', policyFor('block')));
    expect(result.text).toBe('SSN [SSN]');
  });

  it('treats an unknown label as block rather than letting it through', () => {
    // The gate's own rule (Decision #16): a classification nobody wrote a
    // rule for is the case that must not slip out.
    const empty: DisclosurePolicy = { rules: [], unlabeled: 'allow' };
    expect(redactText('SSN 123-45-6789', opts('t', empty)).text).toBe('SSN [SSN]');
  });
});

describe('deriveRedactionKey', () => {
  it('derives a stable key from the deployment secret', () => {
    const secret = Buffer.from('b'.repeat(32));
    expect(deriveRedactionKey(secret).equals(deriveRedactionKey(secret))).toBe(true);
  });

  it('does not hand back the secret it was given', () => {
    // The bytes that encrypt OAuth tokens should not also key this namespace.
    const secret = Buffer.from('b'.repeat(32));
    expect(deriveRedactionKey(secret).equals(secret)).toBe(false);
  });

  it('still redacts when no secret is configured', () => {
    // Failing open would leak exactly what the module exists to hide, so an
    // unconfigured deployment gets a per-process key: tokens stop being
    // stable across restarts, and redaction still happens.
    const first = createPseudonymizer(deriveRedactionKey(null), 't');
    expect(first.anonymize(LABEL_MRN, '4417732')).toMatch(/\[MRN-[0-9a-f]{8}\]/);
  });
});
