import type { Selectable } from 'kysely';
import type { Sandboxes } from '../../../db.types';
import type { SandboxKind, SandboxRecord, SandboxState } from './types';

const KINDS: readonly SandboxKind[] = ['user', 'agent', 'project', 'system'];
const STATES: readonly SandboxState[] = [
  'provisioning',
  'running',
  'suspending',
  'suspended',
  'resuming',
  'deleting',
  'deleted',
];

/** A row as a record. The table's CHECK constraints admit exactly these kinds and states. */
export function sandboxRecordOf(row: Selectable<Sandboxes>): SandboxRecord {
  const kind = KINDS.find((known) => known === row.kind);
  const state = STATES.find((known) => known === row.state);
  if (!kind || !state) {
    throw new Error(`sandbox ${row.id} has a kind or state this build does not know`);
  }
  return {
    id: row.id,
    routeKey: row.route_key,
    kind,
    provider: row.provider,
    providerId: row.provider_id,
    state,
    address: row.address,
    error: row.error,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    stateChangedAt: row.state_changed_at,
    verifiedAt: row.verified_at,
  };
}
