import {
  LOG_LEVELS,
  parseAttrPath,
  type FilterExpr,
  type LogQueryToken,
  type LogRow,
} from '@campfhir/bored-logs';
import { compareAsc, like, orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import type { ActivityLogStore } from './types';

/**
 * The adapter's query (bored-logs' PostgresAdapter.query) in JavaScript.
 * See types.ts for where the two provably agree; the rules below follow
 * the adapter's SQL builder leaf by leaf.
 */

type Attr = Row<'log_attr'>;
type Comparison = '>' | '>=' | '<' | '<=';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_RE = /^-?[0-9]+(\.[0-9]+)?$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LEVELS: Record<string, number> = { ...LOG_LEVELS };

function compare(left: number, operator: string, right: number): boolean {
  switch (operator) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    default:
      return left === right;
  }
}

function isComparison(operator: string): operator is Comparison {
  return operator === '>' || operator === '>=' || operator === '<' || operator === '<=';
}

/** textValuePredicate: `value` is the text the SQL compares, `isString` its string-type guard. */
function textMatches(text: string | null, token: LogQueryToken, isString: boolean): boolean {
  if (text === null) return false;
  const { operator, value } = token;
  if (operator === 'contains') return like(text, `%${value}%`, true);
  if (operator === '=') return text === value;
  if (token.cast === 'string') return compare(compareAsc(text, value), operator, 0);
  if (NUMERIC_RE.test(value)) {
    return NUMERIC_RE.test(text) && compare(Number(text), operator, Number(value));
  }
  if (ISO_DATE_RE.test(value)) {
    if (!ISO_DATE_RE.test(text)) return false;
    return compare(new Date(text).getTime(), operator, new Date(value).getTime());
  }
  return isString && compare(compareAsc(text, value), operator, 0);
}

/** `val::jsonb #> path`, or undefined where the path leads nowhere. */
function walk(value: unknown, segments: { type: string; name?: string; index?: number }[]) {
  let current: unknown = value;
  for (const segment of segments) {
    if (segment.type === 'member') {
      if (typeof current !== 'object' || current === null || Array.isArray(current))
        return undefined;
      current = Reflect.get(current, segment.name ?? '');
    } else if (segment.type === 'index') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment.index ?? 0];
    } else return undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

function attrMatches(attr: Attr, token: LogQueryToken): boolean {
  const path = token.literalKey ? null : parseAttrPath(token.key);
  if (attr.val_name !== (path ? path.base : token.key)) return false;
  if (!path) {
    if (token.nullValue) return attr.val_type === 'null';
    return textMatches(attr.val, token, attr.val_type === 'string');
  }
  if (attr.val_type !== 'json' || attr.encrypted || attr.val === null) return false;
  if (path.segments.some((segment) => segment.type === 'wildcard')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(attr.val);
  } catch {
    return false;
  }
  const found = walk(parsed, path.segments);
  if (token.nullValue) return found === null;
  if (found === undefined || found === null) return false;
  const text = typeof found === 'string' ? found : JSON.stringify(found);
  return textMatches(text, token, typeof found === 'string');
}

function leafMatches(log: Row<'logs'>, attrs: Attr[], token: LogQueryToken): boolean {
  const { key, operator, value, negated } = token;
  if (key === '$message' || key === '$msg') {
    const hit = like(log.message, `%${value}%`, true);
    return negated ? !hit : hit;
  }
  if (key === '$timestamp') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return Boolean(negated);
    const at = log.logged_timestamp.getTime();
    let hit: boolean;
    if ((operator === '=' || operator === 'contains') && DATE_ONLY_RE.test(value)) {
      hit = at >= date.getTime() && at < date.getTime() + MS_PER_DAY;
    } else if (operator === 'contains') hit = at === date.getTime();
    else hit = compare(at, operator, date.getTime());
    return negated ? !hit : hit;
  }
  if (key === '$level') {
    const upper = value.toUpperCase();
    if (isComparison(operator)) {
      const threshold = LEVELS[value.toLowerCase()] ?? 0;
      const names = Object.entries(LEVELS)
        .filter(([, rank]) =>
          operator === '>='
            ? rank <= threshold
            : operator === '>'
              ? rank < threshold
              : operator === '<='
                ? rank >= threshold
                : rank > threshold
        )
        .map(([name]) => name.toUpperCase());
      // The adapter applies no negation to a range leaf.
      return names.includes(log.level);
    }
    const hit = operator === 'contains' ? like(log.level, `%${upper}%`, true) : log.level === upper;
    return negated ? !hit : hit;
  }
  const exists = attrs.some((attr) => attrMatches(attr, token));
  return negated ? !exists : exists;
}

function treeMatches(log: Row<'logs'>, attrs: Attr[], node: FilterExpr): boolean {
  if (node.type === 'filter') return leafMatches(log, attrs, node.filter);
  return node.type === 'and'
    ? node.nodes.every((child) => treeMatches(log, attrs, child))
    : node.nodes.some((child) => treeMatches(log, attrs, child));
}

function levelRangeNames(node: FilterExpr): string[] {
  if (node.type === 'filter') {
    const t = node.filter;
    return t.key === '$level' && t.operator !== '=' && t.operator !== 'contains' ? [t.value] : [];
  }
  return node.nodes.flatMap(levelRangeNames);
}

/** _parseLogs: stored text back to typed attribute values. */
function attributesOf(attrs: Attr[], decrypt: ((value: string) => string) | null) {
  const out: Record<string, unknown> = {};
  for (const attr of attrs) {
    let val = attr.val;
    if (decrypt && attr.encrypted && attr.val_type !== 'null' && val !== null) {
      try {
        val = decrypt(val);
      } catch {
        // left as stored, as the adapter does
      }
    }
    if (attr.val_type === 'null') out[attr.val_name] = null;
    else if (attr.val_type === 'date' && val !== null) out[attr.val_name] = new Date(val);
    else if (attr.val_type === 'number' && val !== null) out[attr.val_name] = parseInt(val, 10);
    else if (attr.val_type === 'boolean' && val !== null) out[attr.val_name] = val === 'true';
    else if (attr.val_type === 'json' && val !== null) {
      try {
        out[attr.val_name] = JSON.parse(val);
      } catch {
        out[attr.val_name] = val;
      }
    } else if (attr.val_type === 'binary') {
      // query() never fetches blobs, so a binary attribute is absent.
    } else out[attr.val_name] = val;
  }
  return out;
}

export function memoryActivityLogs(tables: MemoryTables): ActivityLogStore {
  return {
    async search(options, cipher) {
      const start = options.start
        ? new Date(options.start)
        : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const end = options.end ? new Date(options.end) : new Date();
      const limit = Math.min(options.limit ?? 250, 1000);
      const offset = options.offset ?? 0;
      const sort = options.sort ?? 'desc';
      const message = options.message ?? '';
      const filter = options.attributeFilter;

      const known = (level: string) => LEVELS[level.toLowerCase()] !== undefined;
      const invalid = [
        ...(options.level ? [options.level] : []),
        ...(options.levels ?? []),
        ...(options.minLevel ? [options.minLevel] : []),
        ...(filter ? levelRangeNames(filter) : []),
      ].filter((level) => !known(level));
      if (invalid.length > 0) throw new Error('invalid log level');

      const requested = new Set<string>(options.levels ?? []);
      if (options.level) requested.add(options.level);
      if (options.minLevel) {
        const threshold = LEVELS[options.minLevel.toLowerCase()] ?? 0;
        for (const [name, rank] of Object.entries(LEVELS)) {
          if (rank <= threshold) requested.add(name);
        }
      }
      const levels = new Set(
        (requested.size > 0 ? [...requested] : Object.keys(LEVELS)).map((l) => l.toUpperCase())
      );

      const attrsByLog = new Map<string, Attr[]>();
      for (const attr of tables.select('log_attr')) {
        const list = attrsByLog.get(attr.log_id) ?? [];
        list.push(attr);
        attrsByLog.set(attr.log_id, list);
      }
      const matching = tables.select('logs', (log) => {
        const at = log.logged_timestamp.getTime();
        if (at < start.getTime() || at >= end.getTime()) return false;
        if (message !== '' && !like(log.message, `%${message}%`, true)) return false;
        if (!levels.has(log.level)) return false;
        return !filter || treeMatches(log, attrsByLog.get(log.log_id) ?? [], filter);
      });
      const sorted = orderBy(
        matching,
        [(log) => log.logged_timestamp, sort],
        [(log) => Number(log.log_id)]
      );
      const decrypt = cipher ? cipher.decrypt : null;
      return page(sorted, limit, offset).map((log): LogRow => ({
        id: log.log_id,
        level: log.level,
        message: log.message,
        meta: attributesOf(attrsByLog.get(log.log_id) ?? [], decrypt),
        timestamp: log.logged_timestamp.toISOString(),
      }));
    },
    async grantNamesByAccountIds(accountIds) {
      const wanted = new Set(accountIds);
      const rows = tables.select('provider_grants', (r) => wanted.has(r.provider_account_id));
      return orderBy(rows, [(r) => r.provider_account_id], [(r) => r.provider]).map((row) => ({
        providerAccountId: row.provider_account_id,
        displayName: row.display_name,
      }));
    },
  };
}
