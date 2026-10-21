import { checkSelectQuery, isSoqlIdentifier, soqlContains, soqlString } from './soql';

describe('soqlString', () => {
  it('escapes quotes, backslashes and control characters', () => {
    expect(soqlString("O'Brien")).toBe("'O\\'Brien'");
    expect(soqlString('a\\b')).toBe("'a\\\\b'");
    expect(soqlString('line\nbreak')).toBe("'line\\nbreak'");
    // An argument cannot close the literal and add a condition.
    expect(soqlString("x' OR Name != '")).toBe("'x\\' OR Name != \\''");
  });

  it('escapes LIKE wildcards for contains', () => {
    expect(soqlContains('50%_off')).toBe("'%50\\%\\_off%'");
  });
});

describe('isSoqlIdentifier', () => {
  it('accepts API names and relationship paths only', () => {
    expect(isSoqlIdentifier('Site_Visit__c')).toBe(true);
    expect(isSoqlIdentifier('Account.Owner.Name')).toBe(true);
    expect(isSoqlIdentifier('npsp__Primary_Contact__r.Name')).toBe(true);
    expect(isSoqlIdentifier('Name, (SELECT Id FROM Contacts)')).toBe(false);
    expect(isSoqlIdentifier('1Name')).toBe(false);
  });
});

describe('checkSelectQuery', () => {
  it('appends a top-level LIMIT when none is given', () => {
    expect(checkSelectQuery('SELECT Id FROM Account', 200)).toEqual({
      ok: true,
      value: { query: 'SELECT Id FROM Account LIMIT 200', limited: true },
    });
  });

  it('keeps an existing top-level LIMIT, ignoring ones in subqueries and strings', () => {
    expect(checkSelectQuery('SELECT Id FROM Account LIMIT 5;', 200)).toEqual({
      ok: true,
      value: { query: 'SELECT Id FROM Account LIMIT 5', limited: false },
    });
    const sub = checkSelectQuery(
      "SELECT Id, (SELECT Id FROM Contacts LIMIT 3) FROM Account WHERE Name = 'LIMIT 9'",
      100
    );
    expect(sub).toMatchObject({ ok: true, value: { limited: true } });
  });

  it('refuses anything that is not one SELECT', () => {
    expect(checkSelectQuery('DELETE FROM Account', 10)).toMatchObject({ ok: false });
    expect(checkSelectQuery('SELECT Id FROM Account; SELECT Id FROM Contact', 10)).toMatchObject({
      ok: false,
    });
    expect(checkSelectQuery("SELECT Id FROM Account WHERE Name = 'x", 10)).toMatchObject({
      ok: false,
    });
    expect(checkSelectQuery('SELECT Id FROM Account WHERE (Name = 1', 10)).toMatchObject({
      ok: false,
    });
  });
});
