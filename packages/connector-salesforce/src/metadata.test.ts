import {
  buildObjectChildrenPackage,
  checkFieldSpec,
  checkValidationRuleSpec,
  developerNameOf,
  fieldXml,
  isDeveloperName,
  packageXml,
  parseDeployResult,
  validationRuleXml,
  xmlEscape,
} from './metadata';

describe('developer names', () => {
  it('derives the name Setup would from a label', () => {
    expect(developerNameOf('Visit Date (planned)')).toBe('Visit_Date_planned');
    expect(developerNameOf('2nd Visit')).toBe('nd_Visit');
    expect(developerNameOf('!!!')).toBe('');
  });

  it('accepts only names Salesforce accepts', () => {
    expect(isDeveloperName('Visit_Date')).toBe(true);
    expect(isDeveloperName('Visit__Date')).toBe(false);
    expect(isDeveloperName('Visit_')).toBe(false);
    expect(isDeveloperName('1Visit')).toBe(false);
    expect(isDeveloperName('a'.repeat(41))).toBe(false);
  });
});

describe('checkFieldSpec', () => {
  it('settles every option a type needs, deriving the API name', () => {
    expect(
      checkFieldSpec({ object: 'Site_Visit__c', label: 'Visit Notes', type: 'LongTextArea' }, [])
    ).toEqual({
      ok: true,
      value: expect.objectContaining({
        apiName: 'Visit_Notes__c',
        type: 'LongTextArea',
        length: 32768,
        visibleLines: 5,
        required: false,
        trackHistory: false,
      }),
    });
  });

  it('refuses a clash, a bad type, an option a type cannot take, and a bad name', () => {
    const clash = checkFieldSpec({ object: 'Account', label: 'Tier', type: 'Text' }, ['Tier__c']);
    expect(clash).toEqual({ ok: false, errors: ['Account already has a field Tier__c.'] });
    expect(checkFieldSpec({ object: 'Account', label: 'X', type: 'Formula' }, [])).toMatchObject({
      ok: false,
    });
    expect(
      checkFieldSpec({ object: 'Account', label: 'Done', type: 'Checkbox', required: true }, [])
    ).toMatchObject({ ok: false, errors: ['A Checkbox field cannot be required.'] });
    expect(
      checkFieldSpec({ object: 'Account', label: 'Code', type: 'Text', length: 300 }, [])
    ).toMatchObject({ ok: false });
    expect(
      checkFieldSpec({ object: 'Account', label: 'Tier', apiName: 'Tier__x__c', type: 'Text' }, [])
    ).toMatchObject({ ok: false });
  });

  it('builds picklists and lookups with their own rules', () => {
    const picklist = checkFieldSpec(
      {
        object: 'Site_Visit__c',
        label: 'Outcome',
        type: 'Picklist',
        values: ['Completed', { value: 'No show', default: true }],
      },
      []
    );
    expect(picklist).toMatchObject({
      ok: true,
      value: {
        restricted: true,
        values: [
          { value: 'Completed', label: 'Completed', default: false },
          { value: 'No show', label: 'No show', default: true },
        ],
      },
    });
    expect(
      checkFieldSpec({ object: 'Account', label: 'S', type: 'Picklist', values: ['a', 'A'] }, [])
    ).toMatchObject({ ok: false, errors: ['Picklist value "A" is listed twice.'] });

    const lookup = checkFieldSpec(
      {
        object: 'Site_Visit__c',
        label: 'Primary Contact',
        type: 'Lookup',
        referenceTo: 'Contact',
        required: true,
      },
      []
    );
    expect(lookup).toMatchObject({
      ok: true,
      value: { relationshipName: 'Primary_Contact', deleteConstraint: 'Restrict' },
    });
  });
});

describe('checkValidationRuleSpec', () => {
  it('takes a rule and leaves the formula to Salesforce', () => {
    expect(
      checkValidationRuleSpec({
        object: 'Site_Visit__c',
        label: 'Visit date before completing',
        formula: "ISPICKVAL(Stage__c, 'Completed') && ISBLANK(Visit_Date__c)",
        message: 'Enter the visit date before completing the visit.',
        errorDisplayField: 'Visit_Date__c',
      })
    ).toEqual({
      ok: true,
      value: {
        object: 'Site_Visit__c',
        name: 'Visit_date_before_completing',
        active: true,
        formula: "ISPICKVAL(Stage__c, 'Completed') && ISBLANK(Visit_Date__c)",
        message: 'Enter the visit date before completing the visit.',
        errorDisplayField: 'Visit_Date__c',
      },
    });
    expect(checkValidationRuleSpec({ object: 'Account', name: 'R' })).toMatchObject({
      ok: false,
      errors: [
        'A validation rule needs its formula — true when the record is wrong.',
        'A validation rule needs the message people see when it blocks a save.',
      ],
    });
  });
});

describe('XML', () => {
  it('escapes everything a label, help text or formula can hold', () => {
    expect(xmlEscape(`a < b && c > "d" 'e'`)).toBe(
      'a &lt; b &amp;&amp; c &gt; &quot;d&quot; &apos;e&apos;'
    );
    const rule = checkValidationRuleSpec({
      object: 'Account',
      name: 'No_Negative',
      formula: 'AnnualRevenue < 0 && NOT(ISBLANK(Name))',
      message: 'Revenue can’t be negative',
    });
    if (!rule.ok) throw new Error('rule');
    expect(validationRuleXml(rule.value)).toContain(
      '<errorConditionFormula>AnnualRevenue &lt; 0 &amp;&amp; NOT(ISBLANK(Name))</errorConditionFormula>'
    );
  });

  it('writes a field with exactly its type’s elements', () => {
    const field = checkFieldSpec(
      { object: 'Account', label: 'Tier', type: 'Text', length: 20, helpText: 'Gold & Silver' },
      []
    );
    if (!field.ok) throw new Error('field');
    const xml = fieldXml(field.value);
    expect(xml).toContain('<fullName>Tier__c</fullName>');
    expect(xml).toContain('<length>20</length>');
    expect(xml).toContain('<inlineHelpText>Gold &amp; Silver</inlineHelpText>');
    expect(xml).toContain('<type>Text</type>');
    expect(xml).not.toContain('<precision>');
  });

  it('packages only the members being deployed, one file per object', () => {
    const field = checkFieldSpec({ object: 'Account', label: 'Tier', type: 'Text' }, []);
    const rule = checkValidationRuleSpec({
      object: 'Account',
      name: 'Tier_Set',
      formula: 'ISBLANK(Tier__c)',
      message: 'Set a tier',
    });
    if (!field.ok || !rule.ok) throw new Error('specs');
    const built = buildObjectChildrenPackage({ fields: [field.value], rules: [rule.value] });
    expect(Object.keys(built.files).sort()).toEqual(['objects/Account.object', 'package.xml']);
    expect(built.files['package.xml']).toBe(
      packageXml([
        { type: 'CustomField', member: 'Account.Tier__c' },
        { type: 'ValidationRule', member: 'Account.Tier_Set' },
      ])
    );
    expect(built.files['package.xml']).toContain('<version>68.0</version>');
    expect(built.files['package.xml']).toContain('<members>Account.Tier__c</members>');
    expect(built.files['objects/Account.object']).toMatch(/<fields>[\s\S]*<validationRules>/);
  });
});

describe('parseDeployResult', () => {
  it('reads a finished check-only deploy with component errors, string booleans and all', () => {
    expect(
      parseDeployResult({
        id: '0Af000000000001',
        deployResult: {
          id: '0Af000000000001',
          done: 'true',
          success: 'false',
          checkOnly: true,
          status: 'Failed',
          numberComponentsDeployed: '1',
          numberComponentsTotal: '2',
          details: {
            componentFailures: {
              componentType: 'ValidationRule',
              fullName: 'Account.Tier_Set',
              problem: 'Field Tier__c does not exist.',
              lineNumber: 3,
            },
          },
        },
      })
    ).toEqual({
      id: '0Af000000000001',
      done: true,
      status: 'Failed',
      success: false,
      checkOnly: true,
      componentsDeployed: 1,
      componentsTotal: 2,
      failures: [
        {
          type: 'ValidationRule',
          name: 'Account.Tier_Set',
          problem: 'Field Tier__c does not exist.',
          line: 3,
        },
      ],
    });
  });
});
