import { nameKey } from './card';
import { PREVIEW_BUILDERS } from '.';

const ID = '0015e00000AbCdEfGH';
const OTHER = '0035e00000ZyXwVuTS';
const FILE = 'f-1234567890abcdef';

const spec = (tool: string, args: Record<string, unknown>, names: Record<string, string> = {}) =>
  PREVIEW_BUILDERS[tool]!(args, names);
const card = (tool: string, args: Record<string, unknown>, names: Record<string, string> = {}) =>
  JSON.stringify(spec(tool, args, names));

describe('Salesforce cards show names, not ids', () => {
  it('names an updated record by id lookup, and falls back to the object', () => {
    const args = { object: 'Account', record: ID, fields: { Industry: 'Retail' } };
    const named = card('salesforce_update_record', args, { [nameKey('record', ID)]: 'Acme' });
    expect(named).toContain('Update Account Acme');
    expect(named).not.toContain(ID);
    const generic = card('salesforce_update_record', args);
    expect(generic).toContain('Update Account record');
    expect(generic).not.toContain(ID);
  });

  it('keeps a record the person named in words', () => {
    expect(
      card('salesforce_update_record', { object: 'Account', record: 'Acme', fields: {} })
    ).toContain('Update Account Acme');
  });

  it('shows a lookup field written as an id by the name it points at', () => {
    const args = { object: 'Contact', fields: { AccountId: ID } };
    expect(card('salesforce_create_record', args, { [nameKey('record', ID)]: 'Acme' })).toContain(
      '"value":"Acme"'
    );
    expect(card('salesforce_create_record', args)).not.toContain(ID);
  });

  it('relates records, assigns a task and logs activity without ids', () => {
    const relate = card(
      'salesforce_relate_records',
      { from: { record: ID }, to: { record: OTHER } },
      { [nameKey('record', ID)]: 'Acme' }
    );
    expect(relate).toContain('Acme');
    expect(relate).not.toContain(ID);
    expect(relate).not.toContain(OTHER);

    const task = card(
      'salesforce_create_task',
      { subject: 'Call', assignee: OTHER, relatedTo: [{ record: ID }] },
      { [nameKey('user', OTHER)]: 'Ann Lee' }
    );
    expect(task).toContain('Ann Lee');
    expect(task).not.toContain(OTHER);
    expect(task).not.toContain(ID);
    expect(card('salesforce_create_task', { subject: 'Call', assignee: OTHER })).toContain(
      'a Salesforce user'
    );
    expect(
      card('salesforce_log_activity', { subject: 'Hi', relatedTo: [{ record: ID }] })
    ).not.toContain(ID);
  });

  it('upserts by external id without printing the external id, and attaches a staged file by name', () => {
    const upsert = card('salesforce_upsert_record', {
      object: 'Account',
      externalIdField: 'Ext__c',
      externalId: 'X-99-SECRET',
      fields: {},
    });
    expect(upsert).not.toContain('X-99-SECRET');
    expect(
      card(
        'salesforce_upsert_record',
        { object: 'Account', externalIdField: 'Ext__c', externalId: 'X-99-SECRET', fields: {} },
        { [nameKey('external', 'X-99-SECRET')]: 'Acme' }
      )
    ).toContain('Create or update Account Acme');

    const attach = card('salesforce_attach_file', { fileId: FILE, object: 'Account', record: ID });
    expect(attach).not.toContain(FILE);
    expect(attach).not.toContain(ID);
    expect(attach).toContain('The staged file');
    expect(
      card(
        'salesforce_attach_file',
        { fileId: FILE, object: 'Account', record: ID },
        { [nameKey('file', FILE)]: 'contract.pdf' }
      )
    ).toContain('contract.pdf');
  });
});
