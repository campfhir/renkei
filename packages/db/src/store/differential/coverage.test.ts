/**
 * What holds without a database, in every `pnpm test`: every method of
 * every repository has at least one differential scenario (so the
 * Postgres comparison in differential.test.ts reaches it), every scenario
 * names a method that exists, every fixture loads, and the memory store
 * answers each scenario the same way twice.
 */

import { SCENARIOS } from '../domains/scenarios';
import { createMemoryDataStore } from '../memory';
import { runOnMemory, storeMethods } from './harness';

describe('differential coverage', () => {
  const methods = storeMethods(createMemoryDataStore());
  const covered = new Set(SCENARIOS.map((scenario) => scenario.method));

  it('has a scenario for every repository method', () => {
    expect(methods.filter((method) => !covered.has(method))).toEqual([]);
  });

  it('names only methods that exist', () => {
    expect([...covered].filter((method) => !methods.includes(method))).toEqual([]);
  });

  it.each(SCENARIOS.map((scenario) => [`${scenario.method}: ${scenario.name}`, scenario] as const))(
    'answers %s deterministically on memory',
    async (_label, scenario) => {
      const first = await runOnMemory(scenario);
      // A scenario that wants a refusal catches it inside `run`; one that
      // throws out of it is broken (a fixture that does not load, a typo).
      expect(first).toMatchObject({ ok: true });
      const second = await runOnMemory(scenario);
      expect(second).toEqual(first);
    }
  );
});

describe('memory tables', () => {
  it('fills a jsonb column’s array default, as Postgres does', () => {
    const store = createMemoryDataStore();
    const row = store.tables.insert('schedule_calendars', {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Holidays',
    });
    expect(row.dates).toEqual([]);
  });
});
