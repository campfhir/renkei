/**
 * A content block / input item, redacted field by field: any string over
 * 40 chars becomes its length, and one level of nested plain object (a
 * document/image block's `source.data`) gets the same treatment. Shared
 * by both dialects' block-ish shapes — a chat-completions content part
 * and a Responses API input item differ in their field names
 * (`text`/`image_url` vs. `arguments`/`output`) but not in the rule:
 * short structural strings (`type`, `role`, `call_id`) survive, anything
 * that could be arbitrary-length text a person or a tool wrote does not.
 */
function redactBlock(block: unknown): Record<string, unknown> {
  const shape: Record<string, unknown> =
    typeof block === 'object' && block !== null ? { ...block } : {};
  for (const [field, fieldValue] of Object.entries(shape)) {
    if (typeof fieldValue === 'string' && fieldValue.length > 40) {
      shape[field] = `<${fieldValue.length} chars>`;
    } else if (typeof fieldValue === 'object' && fieldValue !== null && !Array.isArray(fieldValue)) {
      const nested: Record<string, unknown> = { ...fieldValue };
      for (const [innerField, innerValue] of Object.entries(nested)) {
        if (typeof innerValue === 'string' && innerValue.length > 40) {
          nested[innerField] = `<${innerValue.length} chars>`;
        }
      }
      shape[field] = nested;
    }
  }
  return shape;
}

/**
 * A provider request, summarized for troubleshooting a rejection: every
 * field NAME and structural value that could be wrong — model, token-limit
 * field and value, temperature, reasoning_effort, tool_choice, message
 * roles and ordering, the URL — with the content itself replaced by
 * lengths. "It sent max_tokens instead of max_completion_tokens" and "the
 * system prompt was 41,000 chars" are visible; what the user wrote is not,
 * so the summary is safe to hand back to the person whose click sent it.
 *
 * Covers both dialects this package speaks: the chat-completions
 * `system`/`messages` and the Responses API's `instructions`/`input` —
 * the latter's items are flatter (a `function_call`'s `arguments`, a
 * `function_call_output`'s `output`, sit at the item's own top level
 * rather than nested under `content`) but carry the same kind of
 * arbitrary-length text that must not reach a log.
 */
export function summarizeWireRequest(url: string, body: Record<string, unknown>): string {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if ((key === 'system' || key === 'instructions') && typeof value === 'string') {
      redacted[key] = `<${value.length} chars>`;
    } else if (key === 'messages' && Array.isArray(value)) {
      redacted[key] = value.map((message) => {
        const entry: { role?: unknown; content?: unknown } =
          typeof message === 'object' && message !== null ? message : {};
        if (typeof entry.content === 'string') {
          return { role: entry.role, content: `<${entry.content.length} chars>` };
        }
        if (Array.isArray(entry.content)) {
          return { role: entry.role, content: entry.content.map(redactBlock) };
        }
        return { role: entry.role };
      });
    } else if (key === 'input' && Array.isArray(value)) {
      // The Responses dialect's items: a role-carrying item redacts its
      // `content` array the same way a chat message does; a
      // function_call/function_call_output item has its sensitive field
      // (`arguments`/`output`) redacted at the item's own top level.
      redacted[key] = value.map((item) => {
        const entry: { role?: unknown; content?: unknown } =
          typeof item === 'object' && item !== null ? item : {};
        if (Array.isArray(entry.content)) {
          return { ...redactBlock(item), content: entry.content.map(redactBlock) };
        }
        return redactBlock(item);
      });
    } else if (key === 'tools' && Array.isArray(value)) {
      redacted[key] = `<${value.length} tool defs>`;
    } else {
      redacted[key] = value;
    }
  }
  return `POST ${url}\n${JSON.stringify(redacted, null, 1)}`.slice(0, 4_000);
}
