import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDestructiveRequest } from './api';
import { MIRTH_OPERATIONS, fillPath, pathParamNames, toMirthDate } from './operations';
import type { OperationSpec, ParamSpec } from './operations';
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
 * agree, every date the spec types as date-time is an `iso-date` here so it
 * gets normalised on the way out, and each body travels as a media type
 * the route consumes.
 */
describe('the operation table against the OpenAPI spec', () => {
  interface SpecParam {
    name: string;
    in: string;
    schema?: { type?: string; format?: string; enum?: string[]; items?: { enum?: string[] } };
  }
  interface SpecOperation {
    parameters?: SpecParam[];
    requestBody?: { content?: Record<string, unknown> };
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
  const specParamFor = (operation: OperationSpec, param: ParamSpec): SpecParam | undefined =>
    routeOf(operation)?.parameters?.find(
      (p) => p.in === param.in && p.name === (param.wire ?? param.name)
    );

  /**
   * The document renders an enum through Java's toString(), which for
   * ContentType is a display name ("Processed Raw"); JAX-RS binds an enum
   * query parameter through valueOf() (Mirth registers converters only for
   * Calendar and MetaDataSearch), so the constant name is what the server
   * parses. A display name folds to its constant here for the comparison.
   */
  const constantOf = (value: string): string => value.toUpperCase().replace(/ /g, '_');

  /** The media type each body kind is sent as (requestFor in apps/web). */
  const MEDIA_TYPE: Record<NonNullable<OperationSpec['body']>['kind'], string> = {
    xml: 'application/xml',
    'xml-value': 'application/xml',
    text: 'text/plain',
    form: 'application/x-www-form-urlencoded',
    multipart: 'multipart/form-data',
  };
  /**
   * The servlet declares `@Consumes(TEXT_PLAIN)` on the attachment export
   * (MessageServletInterface.exportAttachmentServer) while its @RequestBody
   * annotation, which is what the document renders, says application/xml.
   * The route reads plain text; text is what is sent.
   */
  const CONSUMES_TEXT_DESPITE_SPEC = new Set(['export_message_attachment']);

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
      for (const param of operation.params) {
        const wire = param.wire ?? param.name;
        expect({
          tool: operation.tool,
          param: param.name,
          wire,
          found: specParamFor(operation, param) !== undefined,
        }).toEqual({ tool: operation.tool, param: param.name, wire, found: true });
      }
    }
  });

  it('agrees with the spec on enumerations and their repeatability', () => {
    for (const operation of MIRTH_OPERATIONS) {
      for (const param of operation.params) {
        if (typeof param.type !== 'object') continue;
        const schema = specParamFor(operation, param)?.schema;
        const specValues = (schema?.enum ?? schema?.items?.enum ?? []).map(constantOf);
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

  it('enumerates every query parameter the spec enumerates', () => {
    for (const operation of MIRTH_OPERATIONS) {
      for (const param of operation.params) {
        const schema = specParamFor(operation, param)?.schema;
        const enumerated = (schema?.enum ?? schema?.items?.enum) !== undefined;
        expect({ tool: operation.tool, param: param.name, enumerated }).toEqual({
          tool: operation.tool,
          param: param.name,
          enumerated: typeof param.type === 'object',
        });
      }
    }
  });

  it('types every date-time the spec has as iso-date, and nothing else as one', () => {
    for (const operation of MIRTH_OPERATIONS) {
      for (const param of operation.params) {
        const match = specParamFor(operation, param);
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

  it('sends a body exactly when the route takes one, as a media type it consumes', () => {
    for (const operation of MIRTH_OPERATIONS) {
      const consumes = Object.keys(routeOf(operation)?.requestBody?.content ?? {});
      const sent = operation.body ? MEDIA_TYPE[operation.body.kind] : undefined;
      expect({ tool: operation.tool, hasBody: sent !== undefined }).toEqual({
        tool: operation.tool,
        hasBody: consumes.length > 0,
      });
      if (!sent || CONSUMES_TEXT_DESPITE_SPEC.has(operation.tool)) continue;
      expect({ tool: operation.tool, sent, accepted: consumes.includes(sent) }).toEqual({
        tool: operation.tool,
        sent,
        accepted: true,
      });
    }
  });
});
