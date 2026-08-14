/**
 * The default disclosure policy for the MCP channel.
 *
 * Every identifier this module can find is pseudonymised rather than struck,
 * because a stable stand-in keeps the results usable — "these two tickets
 * concern the same record" survives — while the value itself does not reach
 * the model.
 *
 * `unlabeled: 'allow'` is the load-bearing line, and it is the opposite of
 * what the gate defaults to elsewhere for good reason. On a retrieval path,
 * unlabeled content is a candidate whose classification is unknown and
 * withholding it is correct. Here, "unlabeled" means "no detector matched this
 * span", which describes essentially all prose in every tool result. Blocking
 * it would empty every response. This gate filters identifiers out of content
 * that has already passed the access checks; it is not the thing deciding
 * whether content may be seen at all.
 */

import type { DisclosurePolicy } from '@renkei/gates';
import {
  LABEL_CARD,
  LABEL_DOB,
  LABEL_MRN,
  LABEL_PATIENT_NAME,
  LABEL_PHONE,
  LABEL_SSN,
} from './detect';

export const DEFAULT_MCP_POLICY: DisclosurePolicy = {
  rules: [
    { label: LABEL_SSN, decision: 'anonymize' },
    { label: LABEL_CARD, decision: 'anonymize' },
    { label: LABEL_MRN, decision: 'anonymize' },
    { label: LABEL_DOB, decision: 'anonymize' },
    { label: LABEL_PATIENT_NAME, decision: 'anonymize' },
    { label: LABEL_PHONE, decision: 'anonymize' },
  ],
  unlabeled: 'allow',
};
