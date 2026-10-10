/**
 * The worker's one resolution step: from (tenant, instance, subject) to the
 * instance's connection details plus the CALLER'S OWN decrypted credential,
 * opened under the caller's own key (user-credentials.ts). Every
 * uncertain outcome denies, and "no such instance" and "not connected"
 * are distinguished here but collapsed by the tools before a model sees
 * them (ids must not become an existence oracle).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { MirthCredentials } from './credentials';
import { openCredentialsForSubject } from './user-credentials';
import { getInstance, readConnectionCiphertext, type InstanceRow } from './store';

export interface ResolvedTarget {
  instance: InstanceRow;
  credentials: MirthCredentials;
}

export type ResolveError = 'no_instance' | 'not_connected' | 'bad_credentials' | 'store';

export interface SubjectTarget {
  instanceId: string;
  subject: string;
}

/** The enabled instance alone — for probes that carry their own credential. */
export async function resolveInstance(
  db: Kysely<DB>,
  instanceId: string
): Promise<Result<InstanceRow, 'no_instance' | 'store'>> {
  const instance = await getInstance(db, instanceId);
  if (!instance.ok) return err('store' as const);
  if (!instance.val || !instance.val.summary.enabled) return err('no_instance' as const);
  return ok(instance.val);
}

/**
 * The instance and the person's credential. The credential is what the
 * DELEGATE opened and attached to the request (`provided`) — the one
 * process that holds a key (docs/delegate-key-design.md); a worker given
 * none has nothing to open it with and answers `not_connected`.
 */
export async function resolveTarget(
  db: Kysely<DB>,
  target: SubjectTarget,
  provided?: MirthCredentials | null
): Promise<Result<ResolvedTarget, ResolveError>> {
  const instance = await resolveInstance(db, target.instanceId);
  if (!instance.ok) return instance;
  if (provided) return ok({ instance: instance.val, credentials: provided });
  if (provided === null) return err('not_connected' as const);

  const ciphertext = await readConnectionCiphertext(
    db,
    target.instanceId,
    target.subject
  );
  if (!ciphertext.ok) return err('store' as const);
  if (ciphertext.val === null) return err('not_connected' as const);

  const credentials = await openCredentialsForSubject(
    db,
    target.subject,
    ciphertext.val
  );
  if (!credentials.ok) return err('bad_credentials' as const);
  return ok({ instance: instance.val, credentials: credentials.val });
}
