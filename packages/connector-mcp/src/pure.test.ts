import {
  authServerMetadataUrls,
  checkServerUrl,
  isValidSlug,
  mcpProvider,
  namespacedToolName,
  parseAuthServerMetadata,
  parseListedTool,
  parseStoredTools,
  protectedResourceMetadataUrls,
  resourceMetadataFromChallenge,
  serverIdOfProvider,
  slugify,
  splitNamespacedToolName,
  tokenClientAuth,
} from './pure';

describe('names', () => {
  it('slugifies display names into tool-safe slugs', () => {
    expect(slugify('Acme Docs (Prod)!')).toBe('acme_docs_prod');
    expect(isValidSlug(slugify('Acme Docs'))).toBe(true);
    expect(isValidSlug('1abc')).toBe(false);
    expect(isValidSlug('a__b')).toBe(false);
  });

  it('namespaces and splits tool names, within the 64 character limit', () => {
    expect(namespacedToolName('acme', 'search docs')).toBe('acme__search_docs');
    expect(namespacedToolName('acme', 'x'.repeat(100)).length).toBe(64);
    expect(splitNamespacedToolName('acme__search')).toEqual({ slug: 'acme', tool: 'search' });
    expect(splitNamespacedToolName('plain')).toBeNull();
  });

  it('round-trips a server id through its grant provider', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(serverIdOfProvider(mcpProvider(id))).toBe(id);
    expect(serverIdOfProvider('github')).toBeNull();
    expect(serverIdOfProvider('mcp:not-an-id')).toBeNull();
  });
});

describe('checkServerUrl', () => {
  it('requires https, allows loopback http, refuses credentials', () => {
    expect(checkServerUrl('https://mcp.example.com/mcp').ok).toBe(true);
    expect(checkServerUrl('http://localhost:3000/mcp').ok).toBe(true);
    expect(checkServerUrl('http://mcp.example.com/mcp').ok).toBe(false);
    expect(checkServerUrl('https://u:p@mcp.example.com').ok).toBe(false);
    expect(checkServerUrl('nonsense').ok).toBe(false);
  });
});

describe('discovery', () => {
  it('reads the resource metadata URL from a challenge', () => {
    expect(
      resourceMetadataFromChallenge(
        'Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource"'
      )
    ).toBe('https://a.example/.well-known/oauth-protected-resource');
    expect(resourceMetadataFromChallenge(null)).toBeNull();
  });

  it('lists well-known locations path-aware first', () => {
    expect(protectedResourceMetadataUrls('https://a.example/mcp')).toEqual([
      'https://a.example/.well-known/oauth-protected-resource/mcp',
      'https://a.example/.well-known/oauth-protected-resource',
    ]);
    expect(authServerMetadataUrls('https://auth.example/tenant1')[0]).toBe(
      'https://auth.example/.well-known/oauth-authorization-server/tenant1'
    );
  });

  it('parses authorization server metadata and refuses an incomplete one', () => {
    const parsed = parseAuthServerMetadata(
      {
        issuer: 'https://auth.example',
        authorization_endpoint: 'https://auth.example/a',
        token_endpoint: 'https://auth.example/t',
        registration_endpoint: 'https://auth.example/r',
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      },
      'https://auth.example'
    );
    expect(parsed?.registrationEndpoint).toBe('https://auth.example/r');
    expect(parseAuthServerMetadata({ issuer: 'x' }, 'x')).toBeNull();
  });

  it('picks how to authenticate to the token endpoint', () => {
    expect(tokenClientAuth([], false)).toBe('none');
    expect(tokenClientAuth([], true)).toBe('basic');
    expect(tokenClientAuth(['client_secret_post'], true)).toBe('body');
  });
});

describe('parseListedTool', () => {
  it('treats only an explicit readOnlyHint as a read', () => {
    expect(parseListedTool({ name: 'a', annotations: { readOnlyHint: true } })?.readOnly).toBe(
      true
    );
    expect(parseListedTool({ name: 'a' })?.readOnly).toBe(false);
    expect(parseListedTool({ nope: 1 })).toBeNull();
  });
});

describe('parseStoredTools', () => {
  it('round-trips what the cache stores, keeping a read a read', () => {
    const listed = parseListedTool({
      name: 'a',
      description: 'd',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    });
    if (!listed) throw new Error('expected a tool');
    const stored: unknown = JSON.parse(
      JSON.stringify([listed, { ...listed, name: 'b', readOnly: false }])
    );
    expect(parseStoredTools(stored)).toEqual([listed, { ...listed, name: 'b', readOnly: false }]);
  });

  it('drops what is not a tool and treats a missing hint as an act', () => {
    expect(parseStoredTools('nope')).toEqual([]);
    expect(parseStoredTools([{ nope: 1 }, { name: 'x' }])).toEqual([
      { name: 'x', description: '', inputSchema: { type: 'object' }, readOnly: false },
    ]);
  });
});
