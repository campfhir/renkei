import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { MemoryTables } from '../../memory/tables';

/**
 * Whether a run belongs to a person — the delegate's check that the agents
 * worker acts for the run it names. Kept apart from the rest of the
 * repository so the two grow without colliding; index.ts joins them.
 */
export interface AgentRunOwnershipStore {
  /** True when the run exists and its owner is `ownerSubject`; a malformed id is refused. */
  isOwnedBy(runId: string, ownerSubject: string): Promise<boolean>;
}

export function postgresAgentRunOwnership(db: () => Kysely<DB>): AgentRunOwnershipStore {
  return {
    async isOwnedBy(runId, ownerSubject) {
      const row = await db()
        .selectFrom('agent_runs')
        .select('id')
        .where('id', '=', runId)
        .where('owner_subject', '=', ownerSubject)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

export function memoryAgentRunOwnership(tables: MemoryTables): AgentRunOwnershipStore {
  return {
    async isOwnedBy(runId, ownerSubject) {
      const id = runId;
      return (
        tables.first('agent_runs', (r) => r.id === id && r.owner_subject === ownerSubject) !==
        undefined
      );
    },
  };
}
