/**
 * Redaction on the way OUT to the model — the chat's counterpart of the
 * MCP boundary's redaction gate (lib/mcp-tools/redaction-gate.ts), built
 * from the same org settings, detectors, policy and pseudonymizer so an
 * identifier reads the same whichever path carried it.
 *
 * Tool results are already redacted when they come back through the MCP
 * endpoint. What that gate never sees is what the person typed, the text
 * pulled out of an uploaded file, a project's instructions and memory —
 * and those reach the model straight from the chat. This applies the
 * same filter there, and the redacted form is what gets STORED, so the
 * transcript equals what the model saw and a later reader is never shown
 * more than the model was.
 *
 * Best effort, like the gate: it never blocks or fails a turn.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import type { OrgSettings } from '@renkei/settings';
import {
  createPseudonymizer,
  deriveRedactionKey,
  knownDetectors,
  redactText,
  DEFAULT_MCP_POLICY,
  type Pseudonymizer,
  type DetectorKey,
} from '@renkei/redaction';

export interface OutboundRedactor {
  apply(text: string): { text: string; counts: Record<string, number> };
}

const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
const redactionKey = deriveRedactionKey(keyResult.ok ? keyResult.val : null);

export function createOutboundRedactor(
  tenantId: string,
  settings: Pick<OrgSettings, 'redactionEnabled' | 'redactionDetectors' | 'redactionMrnFormats'>
): OutboundRedactor | null {
  if (!settings.redactionEnabled) return null;
  const detectors: readonly DetectorKey[] = knownDetectors(settings.redactionDetectors);
  const pseudonymizer: Pseudonymizer = createPseudonymizer(redactionKey, tenantId);
  return {
    apply(text) {
      if (!text) return { text, counts: {} };
      try {
        return redactText(text, {
          policy: DEFAULT_MCP_POLICY,
          pseudonymizer,
          detectors,
          mrnFormats: settings.redactionMrnFormats,
        });
      } catch {
        // The gate's own rule: a redactor that throws must not swallow
        // the message. Returning the text unredacted mirrors what the MCP
        // gate does for a result it could not process.
        return { text, counts: {} };
      }
    },
  };
}

export function totalRedactions(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}
