/**
 * One row per run for a batch act, tallied in place.
 *
 * The rule `ActOutcomeDescriptor.coalesce: 'run'` declares: an act that is
 * itself a batch (a bulk mail job over five hundred messages, a bulk Jira
 * transition) is reported ONCE per run and headline, and every repeat
 * bumps a count on that same row — "Started archiving a batch of email
 * ×13" — rather than writing a thirteenth row saying the same thing. The
 * toast pile and the push already collapsed repeats per run and tool; the
 * feed page did not, and a weekday sweep over thirteen senders was
 * twenty-six cards saying nothing new after the first.
 *
 * ## Why the bookkeeping is its own module
 *
 * The engine fires `notifier.act()` without awaiting it, so a loop's calls
 * overlap: the second can arrive before the first row is inserted. The
 * claim below is SYNCHRONOUS — the key is taken, and the row's id chosen,
 * before any I/O — and the writes for one key are chained, so the count a
 * row carries only ever goes up and the insert always lands before the
 * first update. That is the whole difficulty, and it is testable with a
 * pair of fakes and no database, which is why it does not live inside the
 * notifier next to the Kysely calls.
 *
 * The tally is per notifier, which is per run — and so per agent, since a
 * run has exactly one. Two agents sweeping the same mailbox at once never
 * share a notifier, so they never share a row; and a fresh run of the
 * same agent starts its count at one, as it should.
 */

export interface TallyWrites {
  /** Insert the first row under this id; resolve whether it exists. */
  insert(id: string): Promise<boolean>;
  /** Re-headline that row for the count so far. Only called after a successful insert. */
  update(id: string, count: number): Promise<void>;
}

export interface TallyOutcome {
  /** True for the call that inserted the row — the one worth a push or an email. */
  first: boolean;
  /** How many times this key has been claimed in the run, this call included. */
  count: number;
}

interface Tally {
  id: string;
  count: number;
  /** Every write for this key, in order; resolves whether the row exists. */
  chain: Promise<boolean>;
}

export interface RunTally {
  /**
   * Claim a key for this call and perform its write. Resolves once THIS
   * call's write has settled — the insert for the first, the tallied
   * headline for a repeat — so a caller awaiting it sees the row as it
   * stands after the call.
   */
  record(key: string, id: string, writes: TallyWrites): Promise<TallyOutcome>;
}

export function createRunTally(): RunTally {
  const tallies = new Map<string, Tally>();
  return {
    async record(key, id, writes) {
      const existing = tallies.get(key);
      if (!existing) {
        const tally: Tally = { id, count: 1, chain: writes.insert(id) };
        tallies.set(key, tally);
        // A failed insert is the notifier's WARN, not ours; the tally keeps
        // the key so the repeats stay quiet rather than each trying afresh
        // and each writing a row of its own.
        await tally.chain.catch(() => false);
        return { first: true, count: 1 };
      }
      existing.count += 1;
      const count = existing.count;
      existing.chain = existing.chain.then(async (exists) => {
        if (!exists) return false;
        await writes.update(existing.id, count);
        return true;
      });
      await existing.chain.catch(() => false);
      return { first: false, count };
    },
  };
}

/** "Started archiving a batch of email" → "Started archiving a batch of email ×13". */
export function talliedHeadline(headline: string, count: number): string {
  return count > 1 ? `${headline} ×${count}` : headline;
}
