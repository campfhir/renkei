/**
 * @renkei/connector-mistral-ocr — Mistral Document AI (OCR 4) on Microsoft
 * Foundry. Unlike connector-fileshares/connector-onbase, this package DOES
 * its own HTTP (the connector-microsoft shape): OCR is a normal internet
 * SaaS call with no on-prem host and no per-user OAuth to isolate, so
 * there is no dedicated worker process — both apps/web (the ad-hoc
 * sandbox_ocr_file tool) and apps/worker (the document-ocr-pipeline batch
 * handler) call `callMistralOcr` directly, resolving config the same way
 * via `resolveMistralOcrConfig`.
 */

export type { MistralOcrConfig, MistralOcrPage, MistralOcrResult, MistralOcrError } from './types';

export { callMistralOcr, describeMistralOcrError } from './client';
export type { MistralOcrInput, MistralOcrCallOptions, MistralOcrLogger } from './client';

export {
  resolveMistralOcrConfig,
  MISTRAL_OCR_CONNECTOR,
  DEFAULT_MISTRAL_OCR_MODEL,
} from './config';
export type { ResolveMistralOcrError } from './config';
