/**
 * The org's enabled models as the chat offers them (llm_model_configs,
 * read-only here; secrets never leave the table). A model whose settings
 * name an image surface (`apiSurface` `images` or `flux`) generates
 * images; every other one answers chat.
 */

export interface EnabledModelRecord {
  id: string;
  label: string;
  provider: string;
  model: string;
  isDefault: boolean;
  /** The stored settings JSON. */
  settings: unknown;
}

export interface ChatModelStore {
  /** Enabled chat models: the default first, then by label (ties by id). */
  listChatModels(): Promise<EnabledModelRecord[]>;
  /** Enabled image generation models, by label (ties by id). */
  listImageModels(): Promise<EnabledModelRecord[]>;
}
