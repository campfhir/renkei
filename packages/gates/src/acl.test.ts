/**
 * The retrieval gate's contract: nothing is disclosed without an affirmative
 * verification, and every uncertain path — missing verifier, verifier error,
 * expired budget — is a denial. These tests are the gate's spec.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { verifyCandidates, withheldNote } from './acl';
import type { AccessVerifier, SourceRef } from './acl';

interface Candidate {
  id: string;
  ref: SourceRef;
}

function candidate(provider: string, refId: string): Candidate {
  return { id: `${provider}-${refId}`, ref: { provider, refId } };
}

function allowing(provider: string, allowedIds: string[]): AccessVerifier {
  return {
    provider,
    verifyAccess: async (_userId, refs) =>
      ok(refs.filter((ref) => allowedIds.includes(ref.refId)).map((ref) => ({ ...ref }))),
  };
}

const BUDGET = { budgetMs: 1000 };

describe('verifyCandidates', () => {
  it('discloses only affirmatively verified candidates', async () => {
    const verifiers = new Map([['atlassian', allowing('atlassian', ['PROJ-1'])]]);
    const candidates = [candidate('atlassian', 'PROJ-1'), candidate('atlassian', 'PROJ-2')];

    const outcome = await verifyCandidates(verifiers, 'user-1', candidates, (c) => c.ref, BUDGET);

    expect(outcome.allowed.map((c) => c.id)).toEqual(['atlassian-PROJ-1']);
    expect(outcome.elided).toBe(1);
  });

  it('denies every candidate of a provider with no registered verifier', async () => {
    const verifiers = new Map([['atlassian', allowing('atlassian', ['PROJ-1'])]]);
    const candidates = [candidate('atlassian', 'PROJ-1'), candidate('webex', 'msg-1')];

    const outcome = await verifyCandidates(verifiers, 'user-1', candidates, (c) => c.ref, BUDGET);

    expect(outcome.allowed.map((c) => c.id)).toEqual(['atlassian-PROJ-1']);
    expect(outcome.elided).toBe(1);
  });

  it('denies the whole batch when the verifier reports failure', async () => {
    const failing: AccessVerifier = {
      provider: 'atlassian',
      verifyAccess: async () => err('VERIFICATION_FAILED' as const),
    };
    const outcome = await verifyCandidates(
      new Map([['atlassian', failing]]),
      'user-1',
      [candidate('atlassian', 'PROJ-1')],
      (c) => c.ref,
      BUDGET
    );

    expect(outcome.allowed).toEqual([]);
    expect(outcome.elided).toBe(1);
  });

  it('denies the whole batch when the verifier throws', async () => {
    const throwing: AccessVerifier = {
      provider: 'atlassian',
      verifyAccess: async () => {
        throw new Error('provider unreachable');
      },
    };
    const outcome = await verifyCandidates(
      new Map([['atlassian', throwing]]),
      'user-1',
      [candidate('atlassian', 'PROJ-1')],
      (c) => c.ref,
      BUDGET
    );

    expect(outcome.allowed).toEqual([]);
    expect(outcome.elided).toBe(1);
  });

  it('drops candidates still unverified when the budget expires', async () => {
    const slow: AccessVerifier = {
      provider: 'atlassian',
      verifyAccess: (_userId, refs) =>
        new Promise((resolve) => setTimeout(() => resolve(ok([...refs])), 5000)),
    };
    const started = Date.now();
    const outcome = await verifyCandidates(
      new Map([['atlassian', slow]]),
      'user-1',
      [candidate('atlassian', 'PROJ-1')],
      (c) => c.ref,
      { budgetMs: 50 }
    );

    expect(Date.now() - started).toBeLessThan(3000);
    expect(outcome.allowed).toEqual([]);
    expect(outcome.elided).toBe(1);
    // Withheld because nobody answered, not because the answer was no. Both
    // withhold; only one of them is the system working.
    expect(outcome.unverified).toBe(1);
  });

  it('does not call a refusal a timeout', async () => {
    const outcome = await verifyCandidates(
      new Map([['atlassian', allowing('atlassian', [])]]),
      'user-1',
      [candidate('atlassian', 'PROJ-1')],
      (c) => c.ref,
      BUDGET
    );

    expect(outcome.elided).toBe(1);
    expect(outcome.unverified).toBe(0);
  });

  it('treats a missing verifier as an answered denial, not a timeout', async () => {
    // No verifier is a deployment bug and still denies — but it denies
    // instantly, so reporting it as "could not verify in time" would send
    // someone looking for a slow provider that does not exist.
    const outcome = await verifyCandidates(
      new Map(),
      'user-1',
      [candidate('atlassian', 'PROJ-1')],
      (c) => c.ref,
      BUDGET
    );

    expect(outcome.elided).toBe(1);
    expect(outcome.unverified).toBe(0);
  });

  it('counts only the timed-out provider when another answers', async () => {
    const slow: AccessVerifier = {
      provider: 'webex',
      verifyAccess: (_userId, refs) =>
        new Promise((resolve) => setTimeout(() => resolve(ok([...refs])), 5000)),
    };
    const outcome = await verifyCandidates(
      new Map([
        ['atlassian', allowing('atlassian', ['PROJ-1'])],
        ['webex', slow],
      ]),
      'user-1',
      [
        candidate('atlassian', 'PROJ-1'),
        candidate('atlassian', 'PROJ-2'),
        candidate('webex', 'msg-1'),
      ],
      (c) => c.ref,
      { budgetMs: 50 }
    );

    expect(outcome.allowed.map((c) => c.id)).toEqual(['atlassian-PROJ-1']);
    // PROJ-2 was refused; only the WebEx ref went unanswered.
    expect(outcome.elided).toBe(2);
    expect(outcome.unverified).toBe(1);
  });

  it('verifies providers independently and merges their grants', async () => {
    const verifiers = new Map([
      ['atlassian', allowing('atlassian', ['PROJ-1'])],
      ['webex', allowing('webex', ['msg-2'])],
    ]);
    const candidates = [
      candidate('atlassian', 'PROJ-1'),
      candidate('webex', 'msg-1'),
      candidate('webex', 'msg-2'),
    ];

    const outcome = await verifyCandidates(verifiers, 'user-1', candidates, (c) => c.ref, BUDGET);

    expect(outcome.allowed.map((c) => c.id).sort()).toEqual(['atlassian-PROJ-1', 'webex-msg-2']);
    expect(outcome.elided).toBe(1);
  });

  it('returns immediately for an empty candidate set', async () => {
    const outcome = await verifyCandidates(
      new Map(),
      'user-1',
      [],
      () => {
        throw new Error('must not be called');
      },
      BUDGET
    );

    expect(outcome).toEqual({ allowed: [], elided: 0, unverified: 0 });
  });
});

describe('withheldNote', () => {
  it('says nothing when nothing was withheld', () => {
    expect(withheldNote(0, 0)).toBe('');
  });

  it('calls a refusal a refusal', () => {
    expect(withheldNote(2, 0)).toContain('do not have access');
    expect(withheldNote(2, 0)).not.toContain('did not respond');
  });

  it('calls a timeout a timeout, and says it is worth retrying', () => {
    const note = withheldNote(2, 2);
    expect(note).toContain('did not respond in time');
    expect(note).toContain('retrying');
    expect(note).not.toContain('do not have access');
  });

  it('reports both when both happened', () => {
    const note = withheldNote(5, 2);
    expect(note).toContain('3 withheld: you do not have access');
    expect(note).toContain('2 withheld: the source did not respond');
  });

  it('still reports the total when the timeout count is missing', () => {
    // Arithmetic on a missing count used to yield NaN, which made every
    // branch false and dropped the note entirely — withholding results while
    // saying nothing at all, which is the one outcome that is never allowed.
    expect(withheldNote(3, Number.NaN)).toContain('3 withheld');
  });

  it('never reports more timeouts than were withheld', () => {
    expect(withheldNote(1, 9)).toContain('1 withheld: the source did not respond');
    expect(withheldNote(1, 9)).not.toContain('do not have access');
  });
});
