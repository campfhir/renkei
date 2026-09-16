/**
 * The worker's one resolution step: from (tenant, instance, subject) to the
 * instance's connection details plus the CALLER'S OWN decrypted credential.
 * Only the Mirth worker calls this — it is the only process holding the
 * encryption key for a purpose other than sealing on the way in. Every
 * uncertain outcome denies, and "no such instance" and "not connected"
 * are distinguished here but collapsed by the tools before a model sees
 * them (ids must not become an existence oracle).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { decryptCredentials, type MirthCredentials } from './credentials';
import { getInstance, readConnectionCiphertext, type InstanceRow } from './store';

export interface ResolvedTarget {
  instance: InstanceRow;
  credentials: MirthCredentials;
}

export type ResolveError = 'no_instance' | 'not_connected' | 'bad_credentials' | 'store';

export interface SubjectTarget {
  tenantId: string;
  instanceId: string;
  subject: string;
}

/** The enabled instance alone — for probes that carry their own credential. */
export async function resolveInstance(
  db: Kysely<DB>,
  tenantId: string,
  instanceId: string
): Promise<Result<InstanceRow, 'no_instance' | 'store'>> {
  const instance = await getInstance(db, tenantId, instanceId);
  if (!instance.ok) return err('store' as const);
  if (!instance.val || !instance.val.summary.enabled) return err('no_instance' as const);
  return ok(instance.val);
}

export async function resolveTarget(
  db: Kysely<DB>,
  encryptionKey: Buffer,
  target: SubjectTarget
): Promise<Result<ResolvedTarget, ResolveError>> {
  const instance = await resolveInstance(db, target.tenantId, target.instanceId);
  if (!instance.ok) return instance;

  const ciphertext = await readConnectionCiphertext(
    db,
    target.tenantId,
    target.instanceId,
    target.subject
  );
  if (!ciphertext.ok) return err('store' as const);
  if (ciphertext.val === null) return err('not_connected' as const);

  const credentials = decryptCredentials(ciphertext.val, encryptionKey);
  if (!credentials.ok) return err('bad_credentials' as const);
  return ok({ instance: instance.val, credentials: credentials.val });
}
