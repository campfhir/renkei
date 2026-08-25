import { checkJql, describeJqlProblem } from './jql';

describe('checkJql', () => {
  it('passes queries it has no complaint about', () => {
    const fine = [
      'project = SCRUM AND status != Done ORDER BY updated DESC',
      'project = ENG AND (status = "In Progress" OR status = Blocked) ORDER BY created DESC',
      'assignee = currentUser()',
      'project in (ENG, OPS) ORDER BY priority',
      'summary ~ "fix (urgent)" AND status = Open',
      "summary ~ 'a ) stray quote-wrapped paren'",
      'text ~ "escaped \\" quote (and paren"',
    ];
    for (const jql of fine) expect(checkJql(jql)).toBeNull();
  });

  it('catches the query from the agent logs', () => {
    // The real failure: 'Expecting ")" but got "ORDER". (line 1, character 67)'
    const jql =
      'project = SUP AND (status = "Waiting for support" OR status = Open ORDER BY created DESC';
    const problem = checkJql(jql);
    expect(problem).not.toBeNull();
    expect(problem?.message).toContain('ORDER BY');
    // The suggestion closes the group BEFORE the sort, which is where it
    // has to go for the query to parse.
    expect(problem?.suggestion).toBe(
      'project = SUP AND (status = "Waiting for support" OR status = Open) ORDER BY created DESC'
    );
  });

  it('reports an unclosed group with no ORDER BY', () => {
    const problem = checkJql('project = ENG AND (status = Open OR status = Blocked');
    expect(problem?.message).toContain('1 open group');
    expect(problem?.suggestion).toBe('project = ENG AND (status = Open OR status = Blocked)');
  });

  it('counts several unclosed groups', () => {
    const problem = checkJql('project = ENG AND ((status = Open OR status = Blocked');
    expect(problem?.message).toContain('2 open groups');
    expect(problem?.suggestion?.endsWith('))')).toBe(true);
  });

  it('reports a stray closing paren', () => {
    const problem = checkJql('project = ENG) AND status = Open');
    expect(problem?.message).toContain('never opened');
    // No suggestion: where the "(" belonged is genuinely unknowable, and
    // guessing would change what the query asks.
    expect(problem?.suggestion).toBeUndefined();
  });

  it('reports ORDER BY inside a group that does close', () => {
    const problem = checkJql('project = ENG AND (status = Open ORDER BY created DESC)');
    expect(problem?.message).toContain('inside parentheses');
  });

  it('rejects an empty query', () => {
    expect(checkJql('   ')?.message).toContain('empty');
  });

  it('does not mistake parens inside quotes for structure', () => {
    // The check must not become an obstacle to valid queries.
    expect(checkJql('summary ~ "((((" AND project = ENG')).toBeNull();
    expect(checkJql("comment ~ 'see (ticket) below' ORDER BY created")).toBeNull();
  });

  it('does not treat a word merely containing "order by" as the clause', () => {
    expect(checkJql('project = ENG AND summary ~ "reorder by hand"')).toBeNull();
  });

  it('is case-insensitive about the clause', () => {
    expect(checkJql('project = ENG AND (a = b order by created')?.suggestion).toBe(
      'project = ENG AND (a = b) order by created'
    );
  });
});

describe('describeJqlProblem', () => {
  it('offers the suggestion when there is one', () => {
    const text = describeJqlProblem({ message: 'Broken.', suggestion: 'project = ENG' });
    expect(text).toContain('Did you mean:');
    expect(text).toContain('project = ENG');
  });

  it('says only the message when there is not', () => {
    expect(describeJqlProblem({ message: 'Broken.' })).toBe('Broken.');
  });
});
