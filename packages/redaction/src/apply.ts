/**
 * Turning findings into text, under the org's disclosure policy.
 *
 * The policy engine already existed and had never been wired to anything
 * (`@renkei/gates/disclosure`, RENKEI.md Decisions #15 and #16). This is its
 * first consumer, which is why the decision vocabulary is borrowed rather than
 * reinvented: an org that later writes rules for the email or card channels
 * writes them in the same terms.
 *
 * How each decision becomes an edit, from least to most restrictive, matching
 * the gate's own ordering:
 *
 *   allow      leave it exactly as it is
 *   redact     mask, keeping a four-character tail to reconcile against
 *   anonymize  a stable pseudonym: linkage survives, the value does not
 *   escalate   struck entirely — no human is standing by mid-tool-call
 *   block      struck entirely
 *
 * `escalate` and `block` cannot mean what they mean elsewhere. There is no
 * approval step inside a tool call, and dropping the response was explicitly
 * ruled out: this is a best-effort filter, not a circuit breaker, and a tool
 * that silently returns nothing is worse than one that returns text with the
 * identifiers struck out. Both therefore collapse to the strongest edit
 * available on a span — total removal with no linkage — which is more
 * restrictive than either `redact` or `anonymize`, so nothing is weakened by
 * the collapse. What is lost is the human-approval step, and no caller should
 * read a struck span as having been approved.
 */

import { evaluateDisclosure, type DisclosurePolicy } from '@renkei/gates';
import { detect, type DetectOptions, type Finding } from './detect';
import type { Pseudonymizer } from './pseudonym';

/** The egress channel this module speaks for. */
export const MCP_CHANNEL = 'mcp';

export interface RedactionResult {
  text: string;
  /** What was replaced, by label, for counting. Never the values themselves. */
  counts: Record<string, number>;
}

export interface RedactOptions extends DetectOptions {
  policy: DisclosurePolicy;
  pseudonymizer: Pseudonymizer;
  channel?: string;
}

function replacementFor(finding: Finding, options: RedactOptions): string | null {
  const { decision } = evaluateDisclosure(
    [finding.label],
    options.channel ?? MCP_CHANNEL,
    options.policy
  );
  switch (decision) {
    case 'allow':
      return null;
    case 'redact':
      return options.pseudonymizer.mask(finding.label, finding.value);
    case 'anonymize':
      return options.pseudonymizer.anonymize(finding.label, finding.value);
    default:
      // 'escalate' and 'block' — see the module comment.
      return options.pseudonymizer.strike(finding.label);
  }
}

/**
 * Redact one string. Returns the original when nothing matched, so callers can
 * cheaply tell whether anything changed.
 */
export function redactText(text: string, options: RedactOptions): RedactionResult {
  const findings = detect(text, options);
  if (findings.length === 0) return { text, counts: {} };

  const counts: Record<string, number> = {};
  // Right to left: replacing from the end keeps every earlier offset valid.
  let out = text;
  for (let i = findings.length - 1; i >= 0; i -= 1) {
    const finding = findings[i];
    if (!finding) continue;
    const replacement = replacementFor(finding, options);
    if (replacement === null) continue;
    out = out.slice(0, finding.start) + replacement + out.slice(finding.end);
    counts[finding.label] = (counts[finding.label] ?? 0) + 1;
  }
  return { text: out, counts };
}
