/**
 * A `.env` file, read the way dotenv reads it: one `NAME=value` per line,
 * `#` comments, an optional `export ` prefix, single or double quotes
 * around a value (double quotes unescape `\n`, `\t`, `\"`, `\\`), and a
 * `#` after an unquoted value starting a comment. A line that is not a
 * variable is reported by number rather than silently dropped, so a
 * person pasting a file learns what did not take. Names and values are
 * NOT validated here — the worker's `validateEnvName`/`validateEnvValue`
 * decide what may be stored — this only says what the text contained.
 */

export interface ParsedDotenv {
  values: Record<string, string>;
  /** Lines that were not variables, as "line N: why". */
  problems: string[];
}

const LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unescapeDoubleQuoted(raw: string): string {
  return raw.replace(/\\([nrt"\\])/g, (_whole, code: string) => {
    switch (code) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '"':
        return '"';
      default:
        return '\\';
    }
  });
}

export function parseDotenv(text: string): ParsedDotenv {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const number = index + 1;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(LINE_PATTERN);
    if (!match) {
      problems.push(`line ${number}: not a NAME=value line`);
      continue;
    }
    const name = match[1]!;
    let rest = match[2]!;
    let value: string;
    if (rest.startsWith('"')) {
      // A double-quoted value may span lines until the closing quote.
      let body = rest.slice(1);
      let closed = false;
      for (;;) {
        const end = body.search(/(?<!\\)"/);
        if (end !== -1) {
          body = body.slice(0, end);
          closed = true;
          break;
        }
        if (index + 1 >= lines.length) break;
        index += 1;
        body += `\n${lines[index]!}`;
      }
      if (!closed) {
        problems.push(`line ${number}: unterminated quoted value`);
        continue;
      }
      value = unescapeDoubleQuoted(body);
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end === -1) {
        problems.push(`line ${number}: unterminated quoted value`);
        continue;
      }
      value = rest.slice(1, end);
    } else {
      // Unquoted: up to an inline comment, trailing space trimmed.
      const comment = rest.search(/\s#/);
      if (comment !== -1) rest = rest.slice(0, comment);
      value = rest.trim();
    }
    values[name] = value;
  }
  return { values, problems };
}
