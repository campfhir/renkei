/**
 * The filter path's first coverage that runs without a database.
 *
 * `apps/worker-agents/src/event-fanout.test.ts` is `describe.skip` unless
 * DATABASE_URL is set, so before this file a filter bug survived a clean
 * `pnpm test`. The weight here is on the NEGATIVE direction — an event that
 * must NOT fire — because a filter that lets everything through looks
 * exactly like no filter at all, and nothing downstream notices.
 */

import {
  describeFilters,
  isEmptyMatch,
  isTriggerMatch,
  matchesFilters,
  normalizeMatch,
  validateMatch,
} from './trigger-filters';
import {
  TRIGGER_EVENT_CATALOG,
  matchesTriggerEvent,
  normalizeMatchForEvent,
  triggerFilterFields,
  validateMatchForEvent,
} from './trigger-catalog';

const MAIL = 'microsoft/mail.received';
const WEBEX = 'webex/message.received';
const ZOOM = 'zoom/recording.transcript_completed';

const mail = (over: Record<string, unknown> = {}) => ({
  subject: 'Invoice 4021 is ready',
  body: 'preview',
  from: 'alice@customer.example',
  messageId: 'm-1',
  ...over,
});

const webex = (over: Record<string, unknown> = {}) => ({
  text: 'hello',
  sender: 'bob@corp.example',
  roomId: 'Y2lzY29zcGFyazovL3VzL1JPT00vQUFB',
  messageId: 'w-1',
  ...over,
});

describe('the catalog binds filters to the payload', () => {
  it('only filters on keys the event actually provides', () => {
    // The binding the catalog's doc comment claims. Without this a filter
    // can name a key the fan-out never sets, which fails closed forever —
    // an agent that never fires, with nothing anywhere saying why.
    const offenders = TRIGGER_EVENT_CATALOG.flatMap((event) => {
      const provided = new Set(event.provides.map((v) => v.name.replace(/^trigger\./, '')));
      return event.filters
        .filter((field) => !provided.has(field.payloadKey))
        .map((field) => `${event.id}.${field.id} reads "${field.payloadKey}"`);
    });
    expect(offenders).toEqual([]);
  });

  it('gives every filter field a unique id within its event', () => {
    for (const event of TRIGGER_EVENT_CATALOG) {
      const ids = event.filters.map((field) => field.id);
      expect(ids).toEqual([...new Set(ids)]);
    }
  });

  it('gives every picker-list field a picker to draw from', () => {
    for (const event of TRIGGER_EVENT_CATALOG) {
      for (const field of event.filters) {
        if (field.input === 'picker-list') expect(field.picker).toBeDefined();
      }
    }
  });

  it('yields no filters for an unknown event, rather than throwing', () => {
    expect(triggerFilterFields('nope/at-all')).toEqual([]);
    expect(matchesTriggerEvent('nope/at-all', { anything: 'x' }, {})).toBe(true);
  });
});

describe('no constraint means no constraint', () => {
  it.each([
    ['absent', undefined],
    ['empty object', {}],
    ['empty list', { roomIds: [] }],
    ['empty string', { subjectContains: '' }],
    ['whitespace only', { subjectContains: '   ' }],
    ['null', null],
  ])('%s fires', (_label, match) => {
    expect(matchesTriggerEvent(MAIL, match, mail())).toBe(true);
    expect(matchesTriggerEvent(WEBEX, match, webex())).toBe(true);
  });

  it('never means "match nothing"', () => {
    // The failure direction that matters: an agent silently ceasing to fire
    // is worse than one firing too often, so empty must stay permissive.
    expect(matchesTriggerEvent(MAIL, { fromAddresses: [] }, mail())).toBe(true);
    expect(isEmptyMatch(triggerFilterFields(MAIL), { fromAddresses: [] })).toBe(true);
  });
});

describe('the negative direction, one per matcher', () => {
  it('address-domain: a different domain does not fire', () => {
    expect(
      matchesTriggerEvent(
        MAIL,
        { fromDomain: 'customer.example' },
        mail({ from: 'eve@other.example' })
      )
    ).toBe(false);
  });

  it('address-domain: a domain that is only a suffix does not fire', () => {
    // 'notcustomer.example' ends with 'customer.example' as a string, so the
    // '@' in the comparison is load-bearing.
    expect(
      matchesTriggerEvent(
        MAIL,
        { fromDomain: 'customer.example' },
        mail({ from: 'eve@notcustomer.example' })
      )
    ).toBe(false);
  });

  it('equals-any: an unlisted sender does not fire', () => {
    expect(
      matchesTriggerEvent(
        MAIL,
        { fromAddresses: ['alice@customer.example'] },
        mail({ from: 'mallory@customer.example' })
      )
    ).toBe(false);
  });

  it('contains: a subject without the needle does not fire', () => {
    expect(
      matchesTriggerEvent(MAIL, { subjectContains: 'invoice' }, mail({ subject: 'Holiday party' }))
    ).toBe(false);
  });

  it('id-equals-any: a message in another space does not fire', () => {
    expect(
      matchesTriggerEvent(WEBEX, { roomIds: ['ROOM-A', 'ROOM-B'] }, webex({ roomId: 'ROOM-Z' }))
    ).toBe(false);
  });

  it('zoom: another host does not fire', () => {
    expect(
      matchesTriggerEvent(
        ZOOM,
        { hostEmails: ['lead@corp.example'] },
        { hostEmail: 'other@corp.example' }
      )
    ).toBe(false);
  });
});

describe('within a field OR, between fields AND', () => {
  it('matches any one of several addresses', () => {
    const match = normalizeMatchForEvent(MAIL, {
      fromAddresses: ['a@x.example', 'alice@customer.example', 'c@z.example'],
    });
    expect(matchesTriggerEvent(MAIL, match, mail())).toBe(true);
  });

  it('requires every constrained field', () => {
    const match = { fromDomain: 'customer.example', subjectContains: 'invoice' };
    expect(matchesTriggerEvent(MAIL, match, mail())).toBe(true);
    // Right sender, wrong subject.
    expect(matchesTriggerEvent(MAIL, match, mail({ subject: 'Holiday party' }))).toBe(false);
    // Right subject, wrong sender.
    expect(matchesTriggerEvent(MAIL, match, mail({ from: 'eve@other.example' }))).toBe(false);
  });
});

describe('case folding is per matcher', () => {
  it('folds human text', () => {
    expect(
      matchesTriggerEvent(
        MAIL,
        normalizeMatchForEvent(MAIL, { fromAddresses: ['Alice@Customer.Example'] }),
        mail({ from: 'ALICE@CUSTOMER.EXAMPLE' })
      )
    ).toBe(true);
    expect(
      matchesTriggerEvent(MAIL, { subjectContains: 'invoice' }, mail({ subject: 'INVOICE 9' }))
    ).toBe(true);
  });

  it('does NOT fold opaque provider ids', () => {
    // A WebEx room id is base64 of a URN. Lowercasing one yields a filter
    // that silently never matches, which is the worst possible outcome.
    const stored = normalizeMatchForEvent(WEBEX, { roomIds: ['RoomAbc'] });
    expect(stored.roomIds).toEqual(['RoomAbc']);
    expect(matchesTriggerEvent(WEBEX, stored, webex({ roomId: 'RoomAbc' }))).toBe(true);
    expect(matchesTriggerEvent(WEBEX, stored, webex({ roomId: 'roomabc' }))).toBe(false);
  });
});

describe('fail closed on a missing payload key', () => {
  it('a stated constraint is not satisfied by an absent value', () => {
    expect(matchesTriggerEvent(MAIL, { fromAddresses: ['a@b.example'] }, { subject: 'hi' })).toBe(
      false
    );
    expect(matchesTriggerEvent(MAIL, { fromDomain: 'b.example' }, mail({ from: '' }))).toBe(false);
    expect(matchesTriggerEvent(WEBEX, { roomIds: ['A'] }, webex({ roomId: 42 }))).toBe(false);
  });
});

describe('fail open on an unknown field id', () => {
  it('ignores the unknown one and still applies its siblings', () => {
    // The rollback case: deploy N-1 reading a filter deploy N wrote.
    const match = { somethingNewer: 'x', subjectContains: 'invoice' };
    expect(matchesTriggerEvent(MAIL, match, mail())).toBe(true);
    expect(matchesTriggerEvent(MAIL, match, mail({ subject: 'Holiday party' }))).toBe(false);
  });

  it('drops unknown keys when normalising, so a typo cannot look effective', () => {
    expect(normalizeMatchForEvent(MAIL, { subjetcContains: 'invoice' })).toEqual({});
  });
});

describe('jsonb junk is survivable', () => {
  it.each([
    ['a number', { fromDomain: 42 }],
    ['objects in a list', { roomIds: [{}] }],
    ['a nested list', { roomIds: [['a']] }],
    ['an array at the top', ['nope']],
    ['a bare string', 'nope'],
  ])('%s is treated as absent and never throws', (_label, raw) => {
    expect(() => normalizeMatchForEvent(MAIL, raw)).not.toThrow();
    expect(() => matchesTriggerEvent(MAIL, raw, mail())).not.toThrow();
    expect(matchesTriggerEvent(MAIL, raw, mail())).toBe(true);
  });

  it('rejects a non-filter shape at the wire guard', () => {
    expect(isTriggerMatch({ a: 'x' })).toBe(true);
    expect(isTriggerMatch({ a: ['x'] })).toBe(true);
    expect(isTriggerMatch({ a: 42 })).toBe(false);
    expect(isTriggerMatch({ a: [{}] })).toBe(false);
    expect(isTriggerMatch(['x'])).toBe(false);
    expect(isTriggerMatch(null)).toBe(false);
  });
});

describe('normalising', () => {
  it('trims, dedupes and drops empties', () => {
    expect(
      normalizeMatchForEvent(MAIL, {
        fromAddresses: [' a@b.example ', 'A@B.example', '', '   ', 'c@d.example'],
      }).fromAddresses
    ).toEqual(['a@b.example', 'c@d.example']);
  });

  it('caps a list at the field maximum', () => {
    const many = Array.from({ length: 40 }, (_, i) => `p${i}@b.example`);
    expect((normalizeMatchForEvent(MAIL, { fromAddresses: many }).fromAddresses ?? []).length).toBe(
      25
    );
  });

  it('is idempotent, so the stored form is canonical', () => {
    const once = normalizeMatchForEvent(MAIL, {
      fromAddresses: ['A@B.example'],
      fromDomain: 'X.Example',
    });
    expect(normalizeMatchForEvent(MAIL, once)).toEqual(once);
  });
});

describe('validating', () => {
  it('accepts an empty or absent match', () => {
    expect(validateMatchForEvent(MAIL, undefined)).toEqual([]);
    expect(validateMatchForEvent(MAIL, {})).toEqual([]);
  });

  it('reports a bad domain in the words the original check used', () => {
    expect(validateMatchForEvent(MAIL, { fromDomain: 'not a domain' })).toEqual([
      'The sender domain filter is not a valid domain.',
    ]);
  });

  it('reports a bad address and an over-long subject', () => {
    expect(validateMatchForEvent(MAIL, { fromAddresses: ['not-an-address'] })).toHaveLength(1);
    expect(validateMatchForEvent(MAIL, { subjectContains: 'x'.repeat(201) })).toHaveLength(1);
  });

  it('reports an over-cap list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `p${i}@b.example`);
    expect(validateMatchForEvent(MAIL, { fromAddresses: many })).toContain(
      'From these senders takes at most 25 entries.'
    );
  });

  it('says nothing about an unknown field, which the matcher already ignores', () => {
    expect(validateMatchForEvent(MAIL, { somethingNewer: 'x' })).toEqual([]);
  });
});

describe('describing', () => {
  it('returns null when nothing is constrained', () => {
    expect(describeFilters(triggerFilterFields(MAIL), {})).toBeNull();
  });

  it('names a single value but never an opaque id', () => {
    const fields = triggerFilterFields(MAIL);
    expect(describeFilters(fields, { fromAddresses: ['a@b.example'] })).toBe('from a@b.example');
    const room = 'Y2lzY29zcGFyazovL3VzL1JPT00vQUFB';
    expect(describeFilters(triggerFilterFields(WEBEX), { roomIds: [room] })).toBe(
      'in 1 chosen space'
    );
    expect(describeFilters(triggerFilterFields(WEBEX), { roomIds: [room] })).not.toContain(room);
  });

  it('joins several constraints readably', () => {
    expect(
      describeFilters(triggerFilterFields(MAIL), {
        fromAddresses: ['a@b.example', 'c@d.example'],
        subjectContains: 'invoice',
      })
    ).toBe('from any of 2 senders and the subject contains "invoice"');
  });
});

describe('golden: the behaviour the deleted matches() had', () => {
  // event-fanout.ts carried its own copy of this logic. These are the exact
  // cases it handled, asserted against the unified implementation so the
  // deletion cannot have changed what an existing saved trigger does.
  const legacy = (
    filters: { fromDomain?: string; subjectContains?: string },
    payload: Record<string, unknown>
  ) => {
    if (filters.fromDomain) {
      const from = typeof payload.from === 'string' ? payload.from : '';
      if (!from.toLowerCase().endsWith(`@${filters.fromDomain.toLowerCase()}`)) return false;
    }
    if (filters.subjectContains) {
      const subject = typeof payload.subject === 'string' ? payload.subject : '';
      if (!subject.toLowerCase().includes(filters.subjectContains.toLowerCase())) return false;
    }
    return true;
  };

  const cases: {
    filters: { fromDomain?: string; subjectContains?: string };
    payload: Record<string, unknown>;
  }[] = [
    { filters: {}, payload: mail() },
    { filters: { fromDomain: 'customer.example' }, payload: mail() },
    { filters: { fromDomain: 'CUSTOMER.EXAMPLE' }, payload: mail() },
    { filters: { fromDomain: 'other.example' }, payload: mail() },
    { filters: { subjectContains: 'invoice' }, payload: mail() },
    { filters: { subjectContains: 'INVOICE' }, payload: mail() },
    { filters: { subjectContains: 'holiday' }, payload: mail() },
    { filters: { fromDomain: 'customer.example', subjectContains: 'invoice' }, payload: mail() },
    { filters: { fromDomain: 'customer.example', subjectContains: 'holiday' }, payload: mail() },
  ];

  it.each(cases)('agrees on %j', ({ filters, payload }) => {
    expect(matchesTriggerEvent(MAIL, filters, payload)).toBe(legacy(filters, payload));
  });

  it('differs only where the old code was wrong: a missing payload key', () => {
    // The old code coerced a missing `from` to '' and then asked whether ''
    // ended with '@domain' — false, same as here. Kept as a note that the
    // fail-closed rule did not change this case.
    expect(matchesTriggerEvent(MAIL, { fromDomain: 'x.example' }, {})).toBe(
      legacy({ fromDomain: 'x.example' }, {})
    );
  });
});

describe('the primitives work without the catalog', () => {
  it('takes a field list directly', () => {
    const fields = triggerFilterFields(WEBEX);
    expect(matchesFilters(fields, { roomIds: ['A'] }, { roomId: 'A' })).toBe(true);
    expect(normalizeMatch(fields, { roomIds: [' A '] })).toEqual({ roomIds: ['A'] });
    expect(validateMatch(fields, {})).toEqual([]);
  });
});
