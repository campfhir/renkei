/**
 * The organization's service image allow-list (code_service_image_rules).
 * A rule's registry credential is kept as the sealed text the sandbox
 * worker hands in; sealing and opening are the worker's. A pattern is
 * unique: writing a second rule for one fails with 23505, which callers
 * turn into their own "already exists".
 */

export interface CodeServiceImageRuleRecord {
  id: string;
  pattern: string;
  note: string | null;
  registryUsername: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What matching an image needs: the pattern, and the credential's sealed value when there is one. */
export interface CodeServiceImageRuleMatch {
  id: string;
  pattern: string;
  registryUsername: string | null;
  registrySealed: string | null;
}

export interface CodeServiceImageRuleStore {
  /** Every rule, by pattern. */
  list(): Promise<CodeServiceImageRuleRecord[]>;
  count(): Promise<number>;
  /** Every rule with its sealed credential, by pattern. */
  listForMatching(): Promise<CodeServiceImageRuleMatch[]>;
  /** Add a rule (`id` generated unless given). */
  insert(rule: {
    id?: string;
    pattern: string;
    note: string | null;
    registryUsername: string | null;
    registrySealed: string | null;
  }): Promise<CodeServiceImageRuleRecord>;
  /**
   * Change a rule's pattern and note (and `updatedAt`); its credential only
   * when `credential` is given — a pair replaces it, null clears it. Null
   * when there is no such rule.
   */
  update(rule: {
    id: string;
    pattern: string;
    note: string | null;
    updatedAt: Date;
    credential?: { registryUsername: string; registrySealed: string } | null;
  }): Promise<CodeServiceImageRuleRecord | null>;
  /** Whether a rule was deleted. */
  delete(id: string): Promise<boolean>;
  /** Add each of these rules whose pattern is missing; how many were added. */
  insertMissing(rules: { pattern: string; note: string | null }[]): Promise<number>;
}
