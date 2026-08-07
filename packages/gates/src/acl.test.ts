/**
 * The retrieval gate's contract: nothing is disclosed without an affirmative
 * verification, and every uncertain path — missing verifier, verifier error,
 * expired budget — is a denial. These tests are the gate's spec.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { verifyCandidates } from './acl';
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
    const outcome = await verifyCandidates(new Map(), 'user-1', [], () => {
      throw new Error('must not be called');
    }, BUDGET);

    expect(outcome).toEqual({ allowed: [], elided: 0 });
  });
});
