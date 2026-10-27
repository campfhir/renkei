/** One model the org's agents can run on (llm_model_configs). */
export interface LlmModelConfigRecord {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  settings: unknown;
  enabled: boolean;
  isDefault: boolean;
  /** The sealed API key blob, as stored (the caller decrypts). */
  encryptedSecrets: string;
}

export interface LlmModelConfigInput {
  label: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  /** Stored as jsonb. */
  settings: Record<string, unknown>;
  encryptedSecrets: string;
  enabled: boolean;
  isDefault: boolean;
}

export interface LlmModelStore {
  /** Every model, by label (ties by id). */
  list(): Promise<LlmModelConfigRecord[]>;
  get(id: string): Promise<LlmModelConfigRecord | null>;
  /**
   * Add one. Made the default, it takes the default from whichever model
   * held it, in the same step. A label already in use changes nothing.
   */
  create(id: string, input: LlmModelConfigInput): Promise<'created' | 'duplicate-label'>;
  /** Replace one's fields, taking the default the same way `create` does. */
  update(
    id: string,
    input: LlmModelConfigInput
  ): Promise<'updated' | 'not-found' | 'duplicate-label'>;
  /** False when there was no such model. */
  delete(id: string): Promise<boolean>;
  /**
   * The enabled CHAT model (settings.apiSurface not 'images'/'flux') with
   * this id; with null, the org default among them (ties by id). Null when
   * none answers.
   */
  findEnabledChatModel(id: string | null): Promise<LlmModelConfigRecord | null>;
  /**
   * The enabled IMAGE model (settings.apiSurface 'images' or 'flux') with
   * this id; with null, the first by label (ties by id).
   */
  findEnabledImageModel(id: string | null): Promise<LlmModelConfigRecord | null>;
}
