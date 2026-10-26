/**
 * One organization per deployment, so its rows (connector configs, model
 * rosters, settings, rules) are the same rows for every spec in a run. A spec
 * that deletes or rewrites them races with any other that does, so the specs
 * that write them hold this lock for the life of their file: a session lock on
 * a connection the file keeps open, released when the connection ends in
 * afterAll. Specs that do not write those rows run alongside them.
 */

import { Client } from 'pg';

/** A fixed key for the whole run's organization rows. */
const ORGANIZATION_LOCK = 4_242_001;

let holder: Client | null = null;

export async function lockOrganization(): Promise<void> {
  holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  await holder.query('SELECT pg_advisory_lock($1)', [ORGANIZATION_LOCK]);
}

export async function unlockOrganization(): Promise<void> {
  await holder?.end();
  holder = null;
}
