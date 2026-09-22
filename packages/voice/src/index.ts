/**
 * @renkei/voice — speech for the chat, behind one vendor-agnostic contract.
 *
 * `provider.ts` is the interface the app codes against; `config.ts` is the
 * org's stored configuration and the one place a vendor is chosen;
 * `azure-speech.ts` is the first vendor. Dependency-free (plain fetch,
 * injected for tests) so the web app can bundle it for its routes and the
 * tests never touch a network.
 */

export * from './provider';
export * from './config';
export {
  AzureSpeechProvider,
  AZURE_MAX_UTTERANCE_SECONDS,
  AZURE_OUTPUT_CONTENT_TYPE,
  buildSsml,
  azureEndpoints,
  parseAzureDetection,
  parseAzureVoice,
  prosodyRate,
  escapeXml,
} from './azure-speech';
