/**
 * A provider request, summarized for troubleshooting a rejection: every
 * field NAME and structural value that could be wrong — model, token-limit
 * field and value, temperature, reasoning_effort, tool_choice, message
 * roles and ordering, the URL — with the content itself replaced by
 * lengths. "It sent max_tokens instead of max_completion_tokens" and "the
 * system prompt was 41,000 chars" are visible; what the user wrote is not,
 * so the summary is safe to hand back to the person whose click sent it.
 */
export function summarizeWireRequest(url: string, body: Record<string, unknown>): string {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'system' && typeof value === 'string') {
      redacted[key] = `<${value.length} chars>`;
    } else if (key === 'messages' && Array.isArray(value)) {
      redacted[key] = value.map((message) => {
        const entry: { role?: unknown; content?: unknown } =
          typeof message === 'object' && message !== null ? message : {};
        if (typeof entry.content === 'string') {
          return { role: entry.role, content: `<${entry.content.length} chars>` };
        }
        if (Array.isArray(entry.content)) {
          return {
            role: entry.role,
            content: entry.content.map((block) => {
              const shape: Record<string, unknown> =
                typeof block === 'object' && block !== null ? { ...block } : {};
              for (const [field, fieldValue] of Object.entries(shape)) {
                if (typeof fieldValue === 'string' && fieldValue.length > 40) {
                  shape[field] = `<${fieldValue.length} chars>`;
                } else if (
                  typeof fieldValue === 'object' &&
                  fieldValue !== null &&
                  !Array.isArray(fieldValue)
                ) {
                  // One level deeper for nested sources — a document/image
                  // block's base64 lives at source.data.
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
            }),
          };
        }
        return { role: entry.role };
      });
    } else if (key === 'tools' && Array.isArray(value)) {
      redacted[key] = `<${value.length} tool defs>`;
    } else {
      redacted[key] = value;
    }
  }
  return `POST ${url}\n${JSON.stringify(redacted, null, 1)}`.slice(0, 4_000);
}
