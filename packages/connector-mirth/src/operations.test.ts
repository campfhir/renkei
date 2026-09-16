import { isDestructiveRequest } from './api';
import { MIRTH_OPERATIONS, fillPath, pathParamNames } from './operations';
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
