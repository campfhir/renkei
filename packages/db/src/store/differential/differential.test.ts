/**
 * Postgres and memory, side by side: every scenario of every domain
 * (domains/scenarios.ts) runs against a freshly truncated contract
 * database and a fresh memory store seeded with the same rows (the
 * fixture as Postgres stored it), and the two answers — or the two
 * failures, by SQLSTATE — must be equal. Skipped without
 * CONTRACT_DATABASE_URL (see harness.ts for setting one up); CI's
 * data-store job runs it.
 */

import { SCENARIOS } from '../domains/scenarios';
import { openContractDatabase, runOnMemory, runOnPostgres, type ContractDatabase } from './harness';

const url = process.env.CONTRACT_DATABASE_URL;
const maybe = url ? describe : describe.skip;

/**
 * Each scenario truncates every table and seeds its own rows first. On a
 * CI runner whose disk is busy (a long Postgres checkpoint) that can take
 * longer than jest's default 5 s, and a test that times out is not
 * stopped: it goes on seeding while the next scenario truncates and
 * seeds, which then fails on a duplicate key. A scenario gets a minute.
 */
const SCENARIO_TIMEOUT_MS = 60_000;

maybe('postgres and memory answer alike', () => {
  let database: ContractDatabase;

  beforeAll(() => {
    database = openContractDatabase(url ?? '');
  });
  afterAll(async () => {
    await database.close();
  });

  it.each(SCENARIOS.map((scenario) => [`${scenario.method}: ${scenario.name}`, scenario] as const))(
    '%s',
    async (_label, scenario) => {
      const postgres = await runOnPostgres(database, scenario);
      const memory = await runOnMemory(scenario, postgres.rows);
      expect(memory).toEqual(postgres.outcome);
    },
    SCENARIO_TIMEOUT_MS
  );
});
