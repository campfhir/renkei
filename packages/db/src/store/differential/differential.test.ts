/**
 * Postgres and memory, side by side: every scenario of every domain
 * (domains/scenarios.ts) runs against a freshly truncated contract
 * database and a fresh memory store, and the two answers — or the two
 * failures, by SQLSTATE — must be equal. Skipped without
 * CONTRACT_DATABASE_URL (see harness.ts for setting one up); CI's
 * data-store job runs it.
 */

import { SCENARIOS } from '../domains/scenarios';
import { openContractDatabase, runOnMemory, runOnPostgres, type ContractDatabase } from './harness';

const url = process.env.CONTRACT_DATABASE_URL;
const maybe = url ? describe : describe.skip;

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
      const memory = await runOnMemory(scenario);
      expect(memory).toEqual(postgres);
    }
  );
});
