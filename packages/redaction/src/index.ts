/**
 * @renkei/redaction — best-effort removal of identifiers from text on its way
 * to a model (RENKEI.md Decision #15).
 *
 * WHAT THIS IS. One control among several. It reduces how much PHI and PII
 * reaches a model through MCP tool results, deterministically and without any
 * model in the loop. Tool calls always proceed; results are always returned.
 *
 * WHAT THIS IS NOT. It is not a compliance boundary, and nothing here should
 * be described as making a deployment HIPAA-compliant. It does not stand in
 * for a BAA, an access review, an audit trail, or a data-processing agreement.
 * It sees only what passes through MCP tool results — the same data still
 * flows through the provider APIs themselves, through logs elsewhere, and
 * through any other channel the org runs. And it is pattern matching: it finds
 * identifiers that have a recognisable shape or an explicit label, and it will
 * miss a patient's name written into a paragraph of prose with nothing nearby
 * to mark it as one.
 *
 * Treat a redacted result as "less exposed", never as "safe".
 */

export {
  detect,
  DEFAULT_DETECTORS,
  knownDetectors,
  LABEL_SSN,
  LABEL_CARD,
  LABEL_MRN,
  LABEL_DOB,
  LABEL_PATIENT_NAME,
  LABEL_PHONE,
  type DetectorKey,
  type Finding,
  type DetectOptions,
} from './detect';
export { luhnValid } from './luhn';
export {
  createPseudonymizer,
  deriveRedactionKey,
  shortLabel,
  type Pseudonymizer,
} from './pseudonym';
export { redactText, MCP_CHANNEL, type RedactionResult, type RedactOptions } from './apply';
export { DEFAULT_MCP_POLICY } from './policy';
