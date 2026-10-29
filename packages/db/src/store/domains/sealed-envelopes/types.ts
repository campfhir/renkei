/**
 * Columns of values sealed under a deployment key (TOKEN_ENCRYPTION_KEY,
 * the content and sandbox keys), as a key rotation walks them: page
 * through the values not yet under the current key, and swap a value for
 * its re-sealed form only if nobody changed it meanwhile. Values are
 * stored and returned sealed; @renkei/user-keys (rewrap.ts) opens and
 * re-seals them.
 */

/** Tables holding a column sealed under a deployment key. */
export type SealedEnvelopeTable =
  | 'connector_configs'
  | 'llm_model_configs'
  | 'oidc_config'
  | 'knowledge_chunks'
  | 'sandbox_env_secrets'
  | 'code_service_image_rules';

/** One sealed column: its table, the columns that identify a row (in walk order), the column. */
export interface SealedEnvelopeColumn {
  table: SealedEnvelopeTable;
  idColumns: readonly string[];
  column: string;
}

export interface SealedEnvelopeRecord {
  /** The row's id column values, in `idColumns` order, as text. */
  id: string[];
  value: string;
}

export interface SealedEnvelopeStore {
  /**
   * The next `limit` rows whose value is set and NOT LIKE `notLike`, in
   * id-column order, strictly after `after` (the last id of the previous
   * page; null to start).
   */
  pageNotLike(
    column: SealedEnvelopeColumn,
    notLike: string,
    after: string[] | null,
    limit: number
  ): Promise<SealedEnvelopeRecord[]>;
  /** Write `next` over one row's value only while it still holds `stored`; how many changed. */
  replaceIfUnchanged(
    column: SealedEnvelopeColumn,
    id: string[],
    stored: string,
    next: string
  ): Promise<number>;
}
