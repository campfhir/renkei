import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDestructiveRequest } from './api';
import { MIRTH_OPERATIONS, fillPath, pathParamNames, toMirthDate } from './operations';
import type { OperationSpec } from './operations';
import { isMirthPermission } from './permissions';

describe('the operation table', () => {
  it('names every tool once', () => {
    const names = MIRTH_OPERATIONS.map((operation) => operation.tool);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('declares every path parameter exactly once, and no path param that is not in the path', () => {
    for (const operation of MIRTH_OPERATIONS) {
      const inPath = pathParamNames(operation.path).sort();
      const declared = operation.params
        .filter((param) => param.in === 'path')
        .map((param) => param.name)
        .sort();
      expect({ tool: operation.tool, declared }).toEqual({
        tool: operation.tool,
        declared: inPath,
      });
      for (const param of operation.params.filter((p) => p.in === 'path')) {
        expect({ tool: operation.tool, required: param.required }).toEqual({
          tool: operation.tool,
          required: true,
        });
      }
    }
  });

  it('keeps parameter names unique per operation', () => {
    for (const operation of MIRTH_OPERATIONS) {
      const names = operation.params.map((param) => param.name);
      expect({ tool: operation.tool, size: new Set(names).size }).toEqual({
        tool: operation.tool,
        size: names.length,
      });
    }
  });

  it('agrees with isDestructiveRequest on what is destructive', () => {
    for (const operation of MIRTH_OPERATIONS) {
      const sample = fillPath(
        operation.path,
        Object.fromEntries(pathParamNames(operation.path).map((name) => [name, 'x']))
      );
      const classified = isDestructiveRequest(operation.method, sample);
      expect({ tool: operation.tool, destructive: operation.kind === 'destructive' }).toEqual({
        tool: operation.tool,
        destructive: classified,
      });
    }
  });

  it('names a catalog permission per operation, a read permission for every read', () => {
    for (const operation of MIRTH_OPERATIONS) {
      expect({ tool: operation.tool, known: isMirthPermission(operation.permission) }).toEqual({
        tool: operation.tool,
        known: true,
      });
      if (operation.kind === 'read') {
        expect({ tool: operation.tool, read: operation.permission.endsWith('.read') }).toEqual({
          tool: operation.tool,
          read: true,
        });
      }
      if (operation.kind === 'destructive') {
        expect({
          tool: operation.tool,
          permission: /\.(delete|restore|edit)$/.test(operation.permission),
        }).toEqual({ tool: operation.tool, permission: true });
      }
    }
  });

  it('gives GET operations no body and marks them read', () => {
    for (const operation of MIRTH_OPERATIONS.filter((o) => o.method === 'GET')) {
      expect({ tool: operation.tool, body: operation.body, kind: operation.kind }).toEqual({
        tool: operation.tool,
        body: undefined,
        kind: 'read',
      });
    }
  });
});

describe('fillPath', () => {
  it('encodes each parameter once', () => {
    expect(fillPath('/users/{userId}/preferences/{name}', { userId: 7, name: 'a b/c' })).toBe(
      '/users/7/preferences/a%20b%2Fc'
    );
  });
});

describe('toMirthDate', () => {
  it("normalises any ISO 8601 date-time into Mirth's Calendar form, in UTC", () => {
    expect(toMirthDate('2026-09-01T00:00:00Z')).toBe('2026-09-01T00:00:00.000+0000');
    expect(toMirthDate('2026-09-01')).toBe('2026-09-01T00:00:00.000+0000');
    expect(toMirthDate('2015-10-21T07:28:00-07:00')).toBe('2015-10-21T14:28:00.000+0000');
    // The spec's own example form goes through unchanged in value.
    expect(toMirthDate('2015-10-21T07:28:00.000-0700')).toBe('2015-10-21T14:28:00.000+0000');
  });

  it('answers undefined for anything that is not a date', () => {
    expect(toMirthDate('yesterday')).toBeUndefined();
    expect(toMirthDate('')).toBeUndefined();
  });
});

/**
 * The table against the server's own OpenAPI document for 4.5.2
 * (docs/mirth-connect-client-api-open-api-spec.json): every route exists,
 * every parameter reaches Mirth under a key the route reads, enumerations
 * agree, and every date the spec types as date-time is an `iso-date` here
 * so it gets normalised on the way out.
 */
describe('the operation table against the OpenAPI spec', () => {
  interface SpecParam {
    name: string;
    in: string;
    schema?: { type?: string; format?: string; enum?: string[]; items?: { enum?: string[] } };
  }
  interface SpecOperation {
    parameters?: SpecParam[];
  }
  interface Spec {
    info: { version: string };
    paths: Record<string, Record<string, SpecOperation>>;
  }
  // JSON.parse answers any; the annotation narrows it without an assertion.
  const spec: Spec = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../docs/mirth-connect-client-api-open-api-spec.json'),
      'utf8'
    )
  );

  /** `{channelId}` and `{eventId}` are the same slot to the router. */
  const shape = (path: string): string => path.replace(/\{[^}]+\}/g, '{}');
  const routes = new Map<string, SpecOperation>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      routes.set(`${method.toUpperCase()} ${shape(path)}`, operation);
    }
  }
  const routeOf = (operation: OperationSpec): SpecOperation | undefined =>
    routes.get(`${operation.method} ${shape(operation.path)}`);

  /**
   * Known departures, each explained. The four audit routes take their
   * attribute map as a request body in the spec, not as query entries —
   * a pre-existing shape difference this test records rather than hides.
   */
  const NOT_IN_SPEC = new Set([
    'audit_accessed_phi_message:auditMessageAttributesMap',
    'audit_queried_phi_messages:auditMessageAttributesMap',
    'audit_export_messages:auditMessageAttributesMap',
    'audit_export_messages_success:auditMessageAttributesMap',
  ]);
  /**
   * The document renders enum values through Java's toString(), which for
   * ContentType is the display name ("Processed Raw"); JAX-RS binds an enum
   * query parameter through valueOf(), so the constant names here are what
   * the server parses.
   */
  const ENUM_RENDERED_AS_DISPLAY_NAMES = new Set(['export_messages:contentType']);

  it('is the 4.5.2 document', () => {
    expect(spec.info.version).toBe('4.5.2');
  });

  it('names only routes the spec has', () => {
    for (const operation of MIRTH_OPERATIONS) {
      expect({ tool: operation.tool, found: routeOf(operation) !== undefined }).toEqual({
        tool: operation.tool,
        found: true,
      });
    }
  });

  it('sends every parameter under a key its route reads', () => {
    for (const operation of MIRTH_OPERATIONS) {
      const specParams = routeOf(operation)?.parameters ?? [];
      for (const param of operation.params) {
        if (NOT_IN_SPEC.has(`${operation.tool}:${param.name}`)) continue;
        const wire = param.wire ?? param.name;
        const match = specParams.find((p) => p.in === param.in && p.name === wire);
        expect({
          tool: operation.tool,
          param: param.name,
          wire,
          found: match !== undefined,
        }).toEqual({ tool: operation.tool, param: param.name, wire, found: true });
      }
    }
  });

  it('agrees with the spec on enumerations and their repeatability', () => {
    for (const operation of MIRTH_OPERATIONS) {
      const specParams = routeOf(operation)?.parameters ?? [];
      for (const param of operation.params) {
        if (typeof param.type !== 'object') continue;
        if (ENUM_RENDERED_AS_DISPLAY_NAMES.has(`${operation.tool}:${param.name}`)) continue;
        const match = specParams.find(
          (p) => p.in === param.in && p.name === (param.wire ?? param.name)
        );
        const schema = match?.schema;
        const specValues = schema?.enum ?? schema?.items?.enum ?? [];
        expect({
          tool: operation.tool,
          param: param.name,
          values: [...param.type.enum].sort(),
          repeatable: param.type.multiple === true,
        }).toEqual({
          tool: operation.tool,
          param: param.name,
          values: [...specValues].sort(),
          repeatable: schema?.type === 'array',
        });
      }
    }
  });

  it('types every date-time the spec has as iso-date, and nothing else as one', () => {
    for (const operation of MIRTH_OPERATIONS) {
      const specParams = routeOf(operation)?.parameters ?? [];
      for (const param of operation.params) {
        const match = specParams.find(
          (p) => p.in === param.in && p.name === (param.wire ?? param.name)
        );
        if (!match) continue;
        expect({
          tool: operation.tool,
          param: param.name,
          isoDate: param.type === 'iso-date',
        }).toEqual({
          tool: operation.tool,
          param: param.name,
          isoDate: match.schema?.format === 'date-time',
        });
      }
    }
  });
});
