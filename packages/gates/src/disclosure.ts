/**
 * The disclosure gate: classification-label enforcement on every egress path
 * (RENKEI.md Decisions #15 and #16).
 *
 * Content carries classification labels; org-admins author the policy mapping
 * labels to handling per egress channel; this module evaluates that policy
 * deterministically. Classifiers may SUGGEST labels upstream — but once
 * labels are attached, what happens here is pure data: no model reasons
 * about, waives, or reinterprets a handling rule. A label the policy does
 * not know is handled with the most restrictive decision, because an
 * unrecognized classification is exactly the case that must not slip
 * through.
 */

/** What an egress path must do with a piece of content. */
export type DisclosureDecision =
  | 'allow'
  | 'redact'
  | 'anonymize'
  | 'escalate' // require explicit human approval before release
  | 'block';

/**
 * Restrictiveness order for most-restrictive-wins resolution. Escalation is
 * ranked below block: block is a final no, escalate still admits release
 * after a human says yes.
 */
const RESTRICTIVENESS: Record<DisclosureDecision, number> = {
  allow: 0,
  redact: 1,
  anonymize: 2,
  escalate: 3,
  block: 4,
};

export function moreRestrictive(a: DisclosureDecision, b: DisclosureDecision): DisclosureDecision {
  return RESTRICTIVENESS[a] >= RESTRICTIVENESS[b] ? a : b;
}

/**
 * One policy rule: what a label means, optionally narrowed to one egress
 * channel ('mcp', 'model-api', 'email', 'webex-card', …). A channel-specific
 * rule overrides the label's channel-less rule for that channel.
 */
export interface DisclosureRule {
  label: string;
  channel?: string;
  decision: DisclosureDecision;
}

export interface DisclosurePolicy {
  rules: readonly DisclosureRule[];
  /**
   * Decision for content carrying no labels at all. Explicit rather than
   * defaulted in code: whether unclassified content may leave is an org
   * policy choice, not an implementation detail.
   */
  unlabeled: DisclosureDecision;
}

export interface DisclosureVerdict {
  decision: DisclosureDecision;
  /** The label that decided the outcome, for the audit trail. Null when unlabeled. */
  decidingLabel: string | null;
}

/**
 * Evaluate the policy for one piece of content on one egress channel.
 * Across multiple labels, the most restrictive resolved decision wins.
 * A label with no applicable rule resolves to 'block'.
 */
export function evaluateDisclosure(
  labels: readonly string[],
  channel: string,
  policy: DisclosurePolicy
): DisclosureVerdict {
  if (labels.length === 0) {
    return { decision: policy.unlabeled, decidingLabel: null };
  }

  let decision: DisclosureDecision | null = null;
  let decidingLabel: string | null = null;

  for (const label of labels) {
    const channelRule = policy.rules.find((r) => r.label === label && r.channel === channel);
    const generalRule = policy.rules.find((r) => r.label === label && r.channel === undefined);
    // Unknown label → most restrictive plausible handling (Decision #16).
    const resolved = (channelRule ?? generalRule)?.decision ?? 'block';

    if (decision === null || moreRestrictive(resolved, decision) === resolved) {
      decision = resolved;
      decidingLabel = label;
    }
  }

  // labels.length > 0 guarantees the loop assigned both.
  return { decision: decision ?? 'block', decidingLabel };
}
