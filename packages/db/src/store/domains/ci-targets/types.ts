/**
 * CI targets (migration 184): a name, its kind, and each host's runner
 * labels as JSON the store keeps as given (@renkei/ci-blocks reads and
 * checks them). A name already taken is refused with 23505.
 */

export interface CiTargetRecord {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  labels: unknown;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CiTargetInput {
  name: string;
  description: string | null;
  kind: string;
  labels: unknown;
}

export interface CiTargetStore {
  /** Every target, by name (ties by id). */
  list(): Promise<CiTargetRecord[]>;
  get(id: string): Promise<CiTargetRecord | null>;
  create(input: CiTargetInput & { createdBy: string }): Promise<string>;
  /** False when there is no such target. */
  update(id: string, input: CiTargetInput): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}
