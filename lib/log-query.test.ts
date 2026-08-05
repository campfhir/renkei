/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions */
import { buildEnforcedLogQuery, buildLogQueryOptions, parseLogQueryExpr } from './log-query';

describe('parseLogQueryExpr', () => {
  it('should parse simple key:value', () => {
    const result = parseLogQueryExpr('level:error');
    expect(result).toBeTruthy();
    // bored-logs wraps queries in and/or nodes for normalization
    const tree = result as any;
    expect(tree.type).toBe('and');
    expect(tree.nodes).toHaveLength(1);
    const orNode = tree.nodes[0];
    expect(orNode.type).toBe('or');
    expect(orNode.nodes).toHaveLength(1);
    const filter = orNode.nodes[0];
    expect(filter.filter.key).toBe('level');
    expect(filter.filter.value).toBe('error');
  });

  it('should parse AND expressions', () => {
    const result = parseLogQueryExpr('level:error && tool:list_issues');
    expect(result).toBeTruthy();
    const tree = result as any;
    expect(tree.type).toBe('and');
    expect(tree.nodes).toHaveLength(2);
    expect((tree.nodes[0] as any).nodes[0].filter.key).toBe('level');
    expect((tree.nodes[1] as any).nodes[0].filter.key).toBe('tool');
  });

  it('should parse OR expressions', () => {
    const result = parseLogQueryExpr('level:error || level:warn');
    expect(result).toBeTruthy();
    const tree = result as any;
    expect(tree.type).toBe('and');
    expect(tree.nodes).toHaveLength(1);
    const orNode = tree.nodes[0];
    expect(orNode.type).toBe('or');
    expect(orNode.nodes).toHaveLength(2);
  });

  it('should handle parentheses and operator precedence', () => {
    const result = parseLogQueryExpr('(level:error || level:warn) && tool:list_issues');
    expect(result).toBeTruthy();
    const tree = result as any;
    expect(tree.type).toBe('and');
    expect(tree.nodes).toHaveLength(2);
    expect((tree.nodes[0] as any).type).toBe('or');
    expect((tree.nodes[0] as any).nodes).toHaveLength(2);
  });

  it('should return null for empty query', () => {
    expect(parseLogQueryExpr('')).toBeNull();
    expect(parseLogQueryExpr('   ')).toBeNull();
    expect(parseLogQueryExpr(null as any)).toBeNull();
  });

  it('should handle complex queries', () => {
    const result = parseLogQueryExpr(
      '(level:error || level:warn) && (tool:list_issues || tool:get_issue) && status:failure'
    );
    expect(result).toBeTruthy();
    const tree = JSON.stringify(result);
    expect(tree).toContain('error');
    expect(tree).toContain('warn');
    expect(tree).toContain('list_issues');
    expect(tree).toContain('get_issue');
    expect(tree).toContain('failure');
  });
});

describe('buildEnforcedLogQuery', () => {
  const tenantId = 'tenant-123';
  const accountId = 'user-456';

  describe('basic queries', () => {
    it('should add tenant filter for empty query', () => {
      const result = buildEnforcedLogQuery(null, tenantId, accountId);
      expect(result).toBeTruthy();
      // Should have tenant and account in the tree
      const tree = result as any;
      expect(tree.type).toBe('and');
    });

    it('should preserve user query and add enforced filters', () => {
      const result = buildEnforcedLogQuery('level:error', tenantId, accountId);
      expect(result).toBeTruthy();
      // Result should be a tree combining user query with enforced filters
      const tree = result as any;
      expect(tree.type).toBe('and');
    });

    it('should add only tenant filter when accountId not provided', () => {
      const result = buildEnforcedLogQuery('level:error', tenantId);
      expect(result).toBeTruthy();
      const tree = result as any;
      expect(tree.type).toBe('and');
    });
  });

  describe('restricted field removal', () => {
    it('should remove user-provided tenantId', () => {
      const result = buildEnforcedLogQuery(
        'level:error && tenantId:wrong-tenant',
        tenantId,
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should not contain "wrong-tenant"
      expect(tree).not.toContain('wrong-tenant');
      // Should contain enforced tenantId
      expect(tree).toContain(tenantId);
    });

    it('should remove user-provided accountId', () => {
      const result = buildEnforcedLogQuery(
        'level:error && accountId:wrong-user',
        tenantId,
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should not contain "wrong-user"
      expect(tree).not.toContain('wrong-user');
      // Should contain enforced accountId
      expect(tree).toContain(accountId);
    });

    it('should remove user-provided userId', () => {
      const result = buildEnforcedLogQuery(
        'level:error && userId:attacker',
        tenantId,
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should not contain "attacker"
      expect(tree).not.toContain('attacker');
      // Should contain enforced accountId
      expect(tree).toContain(accountId);
    });

    it('should handle multiple restricted fields in query', () => {
      const result = buildEnforcedLogQuery(
        'level:error && tenantId:wrong-tenant && accountId:wrong-user && userId:attacker',
        tenantId,
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should remove all user-provided restricted fields
      expect(tree).not.toContain('wrong-tenant');
      expect(tree).not.toContain('wrong-user');
      expect(tree).not.toContain('attacker');
      // Should contain enforced values
      expect(tree).toContain(tenantId);
      expect(tree).toContain(accountId);
    });
  });

  describe('complex queries', () => {
    it('should preserve OR operators in user query', () => {
      const result = buildEnforcedLogQuery(
        '(level:error || level:warn) && tool:list_issues',
        tenantId,
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should preserve the user's query structure
      expect(tree).toContain('error');
      expect(tree).toContain('warn');
      expect(tree).toContain('list_issues');
      // Should add enforced filters
      expect(tree).toContain(tenantId);
      expect(tree).toContain(accountId);
    });

    it('should collapse empty queries after field removal', () => {
      // If user only queries restricted fields, should become just enforced filters
      const result = buildEnforcedLogQuery(
        'tenantId:wrong && accountId:wrong',
        tenantId,
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should only have enforced values
      expect(tree).toContain(tenantId);
      expect(tree).toContain(accountId);
      expect(tree).not.toContain('wrong');
    });

    it('should handle parenthesized restricted fields', () => {
      const result = buildEnforcedLogQuery(
        '(tenantId:wrong || level:error) && accountId:wrong',
        tenantId,
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should remove restricted fields but keep level:error
      expect(tree).toContain('error');
      expect(tree).toContain(tenantId);
      expect(tree).not.toContain('wrong');
    });
  });

  describe('buildLogQueryOptions', () => {
    it('should return query options with filter and limit', () => {
      const options = buildLogQueryOptions('level:error', tenantId, accountId);
      expect(options).toHaveProperty('filter');
      expect(options).toHaveProperty('limit');
      expect(options.limit).toBe(1000);
    });

    it('should apply enforced filters through buildEnforcedLogQuery', () => {
      const options = buildLogQueryOptions(
        'level:error && tenantId:wrong-tenant',
        tenantId,
        accountId
      );
      const filterStr = JSON.stringify(options.filter);
      // Should not contain wrong tenant
      expect(filterStr).not.toContain('wrong-tenant');
      // Should contain enforced tenant
      expect(filterStr).toContain(tenantId);
    });
  });

  describe('security boundary enforcement', () => {
    it('should prevent privilege escalation via tenantId injection', () => {
      const maliciousQuery = 'level:error && tenantId:admin-tenant && accountId:admin-user';
      const result = buildEnforcedLogQuery(maliciousQuery, 'user-tenant', 'user-123');
      const tree = JSON.stringify(result);
      // Should only have user's tenant and account
      expect(tree).toContain('user-tenant');
      expect(tree).toContain('user-123');
      expect(tree).not.toContain('admin-tenant');
      expect(tree).not.toContain('admin-user');
    });

    it('should prevent cross-user access via accountId injection', () => {
      const maliciousQuery = 'level:error && accountId:other-user-id';
      const result = buildEnforcedLogQuery(maliciousQuery, tenantId, 'my-user-id');
      const tree = JSON.stringify(result);
      // Should only have the enforced accountId
      expect(tree).toContain('my-user-id');
      expect(tree).not.toContain('other-user-id');
    });

    it('should work for operators without accountId restriction', () => {
      const result = buildEnforcedLogQuery(
        'level:error && accountId:anyone',
        tenantId
        // no accountId - operator mode
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should have tenant filter
      expect(tree).toContain(tenantId);
      // Should not have accountId since operator didn't provide it
      expect(tree).not.toContain('anyone');
    });
  });
});
