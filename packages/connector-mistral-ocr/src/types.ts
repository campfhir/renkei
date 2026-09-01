/**
 * Domain vocabulary for Mistral Document AI (OCR 4) on Microsoft Foundry.
 * Trimmed to the fields this connector actually reads — see client.ts's
 * own comment for what is verified vs. assumed about the wire shape.
 */

/** What a tenant configures for this connector (connector_configs, key 'mistral-ocr'). */
export interface MistralOcrConfig {
  /**
   * The exact Target URI Foundry shows for the deployed model — pasted
   * verbatim by whoever configures the connector, not built by this code.
   * Foundry's own routing for a given model/region is not this connector's
   * business to guess.
   */
  endpoint: string;
  /** The deployment/model name, e.g. 'mistral-ocr-4-0'. */
  model: string;
  apiKey: string;
}

export interface MistralOcrPage {
  index: number;
  markdown: string;
}

export interface MistralOcrResult {
  pages: MistralOcrPage[];
  pagesProcessed: number;
}

export type MistralOcrError =
  | { type: 'unconfigured' }
  | { type: 'unreachable'; message: string }
  | { type: 'refused'; status: number; message: string }
  | { type: 'malformed'; message: string };
