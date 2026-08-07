/**
 * @renkei/gates — the two enforcement gates of RENKEI.md, as deterministic
 * pipeline primitives below the agentic layer (Decisions #14–#16, #18).
 *
 * Built ahead of their consumers on purpose: the retrieval pipeline
 * (Phase 1–2) and every egress path must be written on top of these
 * contracts, because neither gate can be retrofitted.
 */

export type {
  SourceRef,
  AccessVerifier,
  VerificationOutcome,
  VerifyOptions,
} from './acl';
export { verifyCandidates } from './acl';

export type {
  DisclosureDecision,
  DisclosureRule,
  DisclosurePolicy,
  DisclosureVerdict,
} from './disclosure';
export { evaluateDisclosure, moreRestrictive } from './disclosure';
