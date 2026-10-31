/**
 * Redacting tool results on their way to the model — the fourth registerTool
 * proxy, alongside the capability, scope and usage gates.
 *
 * A proxy for the same reason the others are: there are 200-odd tools across
 * nine namespaces, and a filter that must be remembered per tool is a filter
 * that will be missing from the one that mattered. Wrapping registration means
 * a tool cannot be added without passing through here.
 *
 * WHAT IT DOES NOT DO, deliberately:
 *
 *   - It never blocks a call. The tool runs, the provider is queried, the
 *     result comes back. This is a filter on what reaches the model, not an
 *     access control — that job belongs to the capability gate and the ACL
 *     gate, both of which already ran.
 *   - It never drops a response or asks a model to discard one. A tool that
 *     silently returns nothing is worse than one that returns text with the
 *     identifiers replaced, and instructing a model to throw away data is not
 *     a control — it is a request.
 *   - It never fails a call. If redaction itself throws, the call still
 *     returns. Which raises the question of what to return, and the answer is
 *     below, because it is the one genuinely dangerous decision in this file.
 *
 * ARGUMENTS ARE NOT TOUCHED. They come FROM the model, so filtering them
 * protects nobody from anything; they are also what the provider needs in
 * order to answer.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { redactText, type DetectorKey, type Pseudonymizer } from '@renkei/redaction';
import type { DisclosurePolicy } from '@renkei/gates';
import { logger } from '@/lib/logger';

type RegisterToolArgs = Parameters<McpServer['registerTool']>;

export interface RedactionContext {
  detectors: readonly DetectorKey[];
  mrnFormats: readonly string[];
  policy: DisclosurePolicy;
  pseudonymizer: Pseudonymizer;
}

/** A content block we are willing to rewrite. */
function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'text' &&
    'text' in block &&
    typeof block.text === 'string'
  );
}

const MAX_DEPTH = 64;

/**
 * Rewrite a tool result: the text blocks of `content`, and every string
 * inside `structuredContent` and `_meta` — the two other places a result
 * carries data a client can read, which card-bearing tools fill with the
 * real rows (a terse text summary beside the full records). Shape,
 * ordering, isError, object keys and unknown block types are left exactly
 * as the tool produced them.
 *
 * Non-text blocks pass through untouched because there is nothing honest to do
 * with them: an identifier inside an image or a binary resource is not
 * something pattern matching can reach, and pretending otherwise by dropping
 * the block would lose data the tool was asked for. No tool in this repo emits
 * one today; the branch exists so that the first one to do so degrades to
 * "unfiltered" rather than "mangled".
 */
function redactResult(result: unknown, context: RedactionContext): unknown {
  if (typeof result !== 'object' || result === null) return result;

  const counts: Record<string, number> = {};
  let changed = false;

  const redactString = (text: string): string => {
    const outcome = redactText(text, {
      policy: context.policy,
      pseudonymizer: context.pseudonymizer,
      detectors: context.detectors,
      mrnFormats: context.mrnFormats,
    });
    if (outcome.text === text) return text;
    changed = true;
    for (const label of Object.keys(outcome.counts)) {
      counts[label] = (counts[label] ?? 0) + (outcome.counts[label] ?? 0);
    }
    return outcome.text;
  };

  /** Every string leaf of a JSON value; a value too deep to walk is withheld, not passed. */
  const redactValue = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object' || value === null) return value;
    if (depth > MAX_DEPTH) throw new Error('result is nested too deeply to filter');
    if (Array.isArray(value)) return value.map((item: unknown) => redactValue(item, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, depth + 1)])
    );
  };

  const rewritten: Record<string, unknown> = { ...result };

  if ('content' in result && Array.isArray(result.content)) {
    rewritten.content = result.content.map((block: unknown) => {
      if (!isTextBlock(block)) return block;
      const text = redactString(block.text);
      return text === block.text ? block : { ...block, text };
    });
  }
  for (const field of ['structuredContent', '_meta']) {
    const value = rewritten[field];
    if (value !== undefined) rewritten[field] = redactValue(value, 0);
  }

  if (!changed) return result;
  // Counts only — the labels and how many, never a value. A log line naming
  // what was redacted would put it back in exactly the place this exists to
  // keep it out of.
  logger.debug('redacted tool result: {summary}', {
    component: 'mcp/redaction',
    summary: Object.entries(counts)
      .map(([label, n]) => `${label}=${n}`)
      .join(' '),
  });
  return rewritten;
}

export function withRedaction(server: McpServer, context: RedactionContext): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...args: RegisterToolArgs) => {
          const [name, config, handler] = args;
          if (typeof handler !== 'function') return target.registerTool(...args);

          const filtered = async (...handlerArgs: unknown[]) => {
            // The SDK types a handler as a union of result shapes, so
            // Parameters/ReturnType over it collapse to the wrong member.
            // These assertions restate what the wrapper guarantees — same
            // arguments in, same shape out — rather than claiming anything new.
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            const forwarded = handlerArgs as Parameters<typeof handler>;
            const result: unknown = await handler(...forwarded);
            try {
              return redactResult(result, context);
            } catch (error) {
              // A bug in redaction must not fail the call — but it must not
              // quietly hand over the unredacted result either, because the
              // caller cannot tell the difference and would read raw PHI as
              // filtered. Returning the tool's own error shape keeps the call
              // alive and says plainly that this result was withheld.
              logger.error('redaction failed, withholding tool result: {error}', {
                component: 'mcp/redaction',
                tool: name,
                error: error instanceof Error ? error.message : String(error),
              });
              return {
                content: [
                  {
                    type: 'text' as const,
                    text:
                      `The result of ${name} could not be filtered for sensitive data, so it ` +
                      'was not returned. This is a fault in Renkei, not a permission problem. ' +
                      'Retrying is reasonable; report it if it persists.',
                  },
                ],
                isError: true,
              };
            }
          };

          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return target.registerTool(name, config, filtered as typeof handler);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
