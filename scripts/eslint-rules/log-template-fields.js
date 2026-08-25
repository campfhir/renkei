/**
 * `{placeholder}` in a log message must be backed by an attribute that
 * exists and cannot be undefined.
 *
 * bored-logs interpolates `{key}` from the attributes object and, when the
 * key is missing, LEAVES THE BRACES IN THE MESSAGE rather than throwing:
 *
 *   template.replace(/\{([\w$]+)\}/g, (_, key) => {
 *     const val = attrs[key];
 *     if (val === void 0) return `{${key}}`;   // <- the whole problem
 *
 * So `failedStep: name ?? undefined` shipped `failed at step "{failedStep}"`
 * to production for every agent failure. Nothing threw, no test could see
 * it, and the surrounding placeholders on the same line resolved fine —
 * which is exactly why it went unnoticed. A type cannot catch this: the
 * attributes object is `Record<string, unknown>` and `undefined` is a
 * perfectly good member of it.
 *
 * The rule is deliberately conservative. It reports only what it can prove
 * from the syntax and stays silent everywhere else — a lint rule that
 * guesses at log calls would be turned off within a week, and a rule that is
 * off catches nothing.
 *
 * Reported:
 *   - a placeholder with no matching key in the attributes object;
 *   - a key whose value is `undefined`, `x ?? undefined`, or `x || undefined`.
 *
 * Not reported (cannot be decided from syntax alone):
 *   - a template that is not a plain string literal;
 *   - an attributes argument that is neither an object literal nor an
 *     identifier resolving to a same-scope `const` object literal;
 *   - objects containing a spread that cannot itself be resolved, or a
 *     computed key.
 */

const LEVELS = new Set([
  'critical',
  'error',
  'warn',
  'info',
  'http',
  'verbose',
  'cache',
  'request',
  'response',
  'sql',
  'debug',
]);

const PLACEHOLDER = /\{([\w$]+)\}/g;

/** `logger.warn(...)`, `this.logger.warn(...)`, `someLogger.warn(...)`. */
function isLoggerCall(node) {
  const callee = node.callee;
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.property.type !== 'Identifier' || !LEVELS.has(callee.property.name)) return false;
  const object = callee.object;
  const name =
    object.type === 'Identifier'
      ? object.name
      : object.type === 'MemberExpression' &&
          !object.computed &&
          object.property.type === 'Identifier'
        ? object.property.name
        : '';
  return /^(_?logger|log)$/i.test(name) || /logger$/i.test(name);
}

function placeholdersOf(template) {
  const names = new Set();
  for (const match of template.matchAll(PLACEHOLDER)) names.add(match[1]);
  return names;
}

/** The static key name of a property, or null when it cannot be known. */
function keyNameOf(property) {
  if (property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
    return property.key.value;
  }
  return null;
}

/**
 * Is this expression capable of producing `undefined`?
 *
 * Only the shapes that say so outright — a wider analysis needs type
 * information and would start reporting things the author cannot act on.
 */
function isMaybeUndefined(value) {
  if (value.type === 'Identifier' && value.name === 'undefined') return true;
  if (value.type === 'UnaryExpression' && value.operator === 'void') return true;
  if (value.type === 'LogicalExpression' && (value.operator === '??' || value.operator === '||')) {
    return isMaybeUndefined(value.right);
  }
  if (value.type === 'ConditionalExpression') {
    return isMaybeUndefined(value.consequent) || isMaybeUndefined(value.alternate);
  }
  return false;
}

/**
 * Resolve an identifier to the object literal it was initialised with, when
 * that is knowable: a `const` with exactly one definition and an object
 * initialiser. Anything reassigned, imported, or built by a call is opaque.
 */
function objectLiteralFor(node, scope) {
  if (node.type === 'ObjectExpression') return node;
  if (node.type !== 'Identifier') return null;
  let current = scope;
  while (current) {
    const variable = current.variables.find((entry) => entry.name === node.name);
    if (variable) {
      if (variable.defs.length !== 1) return null;
      const def = variable.defs[0];
      if (def.type !== 'Variable' || def.parent.kind !== 'const') return null;
      const init = def.node.init;
      return init && init.type === 'ObjectExpression' ? init : null;
    }
    current = current.upper;
  }
  return null;
}

/**
 * Every statically-known key of an object literal, following resolvable
 * spreads. Returns null the moment something opaque appears — a partial key
 * set would produce false "missing attribute" reports.
 */
function staticKeys(object, scope, seen = new Set()) {
  const keys = new Map();
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      const inner = objectLiteralFor(property.argument, scope);
      if (!inner || seen.has(inner)) return null;
      seen.add(inner);
      const innerKeys = staticKeys(inner, scope, seen);
      if (!innerKeys) return null;
      for (const [key, value] of innerKeys) keys.set(key, value);
      continue;
    }
    const name = keyNameOf(property);
    if (name === null) return null;
    keys.set(name, property);
  }
  return keys;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'every {placeholder} in a log message must resolve to an attribute that is never undefined',
    },
    schema: [
      {
        type: 'object',
        properties: {
          // Attributes every record carries because `createLogger` was given
          // them as global `attributes` — a template may name these without
          // the call site repeating them. Kept as configuration rather than
          // hardcoded so the list stays next to the loggers that set it.
          globalAttributes: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        'Log message references {{name}}, but the attributes object has no such key — bored-logs will print the literal text "{{{name}}}" instead of a value.',
      maybeUndefined:
        'Log message references {{name}}, whose value can be undefined — bored-logs prints the literal text "{{{name}}}" when an attribute is missing. Give it a fallback value instead of undefined.',
    },
  },

  create(context) {
    const global = new Set(context.options[0]?.globalAttributes ?? []);
    return {
      CallExpression(node) {
        if (!isLoggerCall(node)) return;
        const [template, attrs] = node.arguments;
        if (!template || template.type !== 'Literal' || typeof template.value !== 'string') return;

        const names = new Set(
          [...placeholdersOf(template.value)].filter((name) => !global.has(name))
        );
        if (names.size === 0) return;

        const scope = context.sourceCode.getScope(node);

        // No attributes argument at all: every placeholder is unbacked.
        if (!attrs) {
          for (const name of names) {
            context.report({ node: template, messageId: 'missing', data: { name } });
          }
          return;
        }

        const object = objectLiteralFor(attrs, scope);
        if (!object) return;
        const keys = staticKeys(object, scope);
        if (!keys) return;

        for (const name of names) {
          const property = keys.get(name);
          if (!property) {
            context.report({ node: template, messageId: 'missing', data: { name } });
            continue;
          }
          if (isMaybeUndefined(property.value)) {
            context.report({ node: property, messageId: 'maybeUndefined', data: { name } });
          }
        }
      },
    };
  },
};
