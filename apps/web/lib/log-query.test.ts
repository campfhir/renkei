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
  const accountId = 'user-456';

  describe('basic queries', () => {
    it('should add the account filter for an empty query', () => {
      const result = buildEnforcedLogQuery(null, accountId);
      expect(result).toBeTruthy();
      const tree = result as any;
      expect(tree.type).toBe('and');
      expect(JSON.stringify(tree)).toContain(accountId);
    });

    it('should preserve user query and add enforced filters', () => {
      const result = buildEnforcedLogQuery('level:error', accountId);
      expect(result).toBeTruthy();
      // Result should be a tree combining user query with enforced filters
      const tree = result as any;
      expect(tree.type).toBe('and');
    });

    it('should add no scope when accountId is not provided', () => {
      const result = buildEnforcedLogQuery('level:error');
      expect(result).toBeTruthy();
      const tree = result as any;
      expect(tree.type).toBe('and');
      expect(tree.nodes).toHaveLength(1);
    });
  });

  describe('restricted field removal', () => {
    it('should remove user-provided accountId', () => {
      const result = buildEnforcedLogQuery(
        'level:error && accountId:wrong-user',
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
      const result = buildEnforcedLogQuery('level:error && userId:attacker', accountId);
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should not contain "attacker"
      expect(tree).not.toContain('attacker');
      // Should contain enforced accountId
      expect(tree).toContain(accountId);
    });

    it('should handle multiple restricted fields in query', () => {
      const result = buildEnforcedLogQuery(
        'level:error && accountId:wrong-user && userId:attacker',
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should remove all user-provided restricted fields
      expect(tree).not.toContain('wrong-user');
      expect(tree).not.toContain('attacker');
      // Should contain enforced values
      expect(tree).toContain(accountId);
    });
  });

  describe('complex queries', () => {
    it('should preserve OR operators in user query', () => {
      const result = buildEnforcedLogQuery(
        '(level:error || level:warn) && tool:list_issues',
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should preserve the user's query structure
      expect(tree).toContain('error');
      expect(tree).toContain('warn');
      expect(tree).toContain('list_issues');
      // Should add enforced filters
      expect(tree).toContain(accountId);
    });

    it('should collapse empty queries after field removal', () => {
      // If user only queries restricted fields, should become just enforced filters
      const result = buildEnforcedLogQuery(
        'userId:wrong && accountId:wrong',
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should only have enforced values
      expect(tree).toContain(accountId);
      expect(tree).not.toContain('wrong');
    });

    it('should handle parenthesized restricted fields', () => {
      const result = buildEnforcedLogQuery(
        '(userId:wrong || level:error) && accountId:wrong',
        accountId
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should remove restricted fields but keep level:error
      expect(tree).toContain('error');
      expect(tree).not.toContain('wrong');
    });
  });

  describe('buildLogQueryOptions', () => {
    // `attributeFilter` is the option the adapter reads. Anything else — the
    // `filter` this used to emit — leaves the query unscoped and returns every
    // row in the table, so the name is the whole point of the test.
    it('should return the filter tree under attributeFilter, with a limit', () => {
      const options = buildLogQueryOptions('level:error', accountId);
      expect(options).toHaveProperty('attributeFilter');
      expect(options.attributeFilter).toBeTruthy();
      expect(options.limit).toBe(1000);
    });

    it('should drop level names the adapter would reject', () => {
      const options = buildLogQueryOptions(null, undefined, {
        levels: ['error', 'not-a-level'],
      });
      expect(options.levels).toEqual(['error']);
    });
  });

  describe('security boundary enforcement', () => {
    it('should prevent privilege escalation via accountId injection', () => {
      const maliciousQuery = 'level:error && userId:admin && accountId:admin-user';
      const result = buildEnforcedLogQuery(maliciousQuery, 'user-123');
      const tree = JSON.stringify(result);
      // Should only have the caller's own account
      expect(tree).toContain('user-123');
      expect(tree).not.toContain('admin-user');
      expect(tree).not.toContain('"admin"');
    });

    it('should prevent cross-user access via accountId injection', () => {
      const maliciousQuery = 'level:error && accountId:other-user-id';
      const result = buildEnforcedLogQuery(maliciousQuery, 'my-user-id');
      const tree = JSON.stringify(result);
      // Should only have the enforced accountId
      expect(tree).toContain('my-user-id');
      expect(tree).not.toContain('other-user-id');
    });

    it('should work for operators without accountId restriction', () => {
      const result = buildEnforcedLogQuery(
        'level:error && accountId:anyone'
        // no accountId - operator mode
      );
      expect(result).toBeTruthy();
      const tree = JSON.stringify(result);
      // Should not have accountId since operator didn't provide it
      expect(tree).not.toContain('anyone');
    });
  });
});
