/**
 * The Salesforce connectors form, as an operator uses it: what the list
 * offers when it is empty, what a connector's summary says, the editor's
 * defaults for a first and a further org of each type, the capability
 * boxes, what Save sends, and what a refusal leaves on screen. These were
 * salesforce.spec.ts's and salesforce-admin.spec.ts's form steps.
 */

import { SALESFORCE_ADMIN_KIND, SALESFORCE_CRM_KIND } from '@/lib/salesforce-kinds';
import {
  addButtonLabel,
  capabilityLabels,
  changeRequestsLine,
  editorReducer,
  editorSections,
  editorTitle,
  emptyListHint,
  initEditor,
  keptAway,
  removeUrl,
  saveBody,
  secretField,
  type EditorAction,
  type EditorProps,
  type EditorState,
  type SalesforceConnectorRow,
} from './salesforce-form.model';

const CRM = SALESFORCE_CRM_KIND;
const ADMIN = SALESFORCE_ADMIN_KIND;

const UAT: SalesforceConnectorRow = {
  key: 'uat',
  name: 'UAT',
  myDomain: 'https://acme--uat.sandbox.my.salesforce.com',
  sandbox: true,
  enabled: true,
  clientId: 'uat-client',
  scopes: 'sf-records-read sf-reports',
  excludedObjects: ['Case_Note__c'],
  excludedFields: ['Contact.Diagnosis__c', 'Contact.Ssn__c'],
  hideRestricted: false,
  productionChanges: false,
  hasClientSecret: true,
};

function editor(props: EditorProps, ...actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, initEditor(props));
}

const typed = (field: Extract<EditorAction, { type: 'text' }>['field'], value: string) =>
  ({ type: 'text', field, value }) as const;
const flagged = (field: Extract<EditorAction, { type: 'flag' }>['field'], value: boolean) =>
  ({ type: 'flag', field, value }) as const;

const sortedScopes = (body: Record<string, unknown>) =>
  String(body.scopes).split(' ').filter(Boolean).sort();

describe('the empty list', () => {
  it('asks a CRM to start with production, and building to start with a sandbox', () => {
    expect(emptyListHint(CRM)).toBe('Start with your production org.');
    expect(emptyListHint(ADMIN)).toBe('Start with a sandbox to build in.');
    expect(addButtonLabel(CRM, 0)).toBe('Add your production org');
    expect(addButtonLabel(ADMIN, 0)).toBe('Add your first org');
  });

  it('offers to add another org once there is one', () => {
    expect(addButtonLabel(CRM, 1)).toBe('Add a Salesforce org');
    expect(addButtonLabel(ADMIN, 2)).toBe('Add a Salesforce org');
  });
});

describe('a connector’s summary', () => {
  it('lists the capabilities its ceiling lets people grant, by name', () => {
    expect(capabilityLabels(CRM, 'sf-records-read sf-reports')).toEqual([
      'Read records',
      'Find and run reports and dashboards',
    ]);
    expect(capabilityLabels(CRM, '')).toEqual([]);
  });

  it('says a sandbox applies approved change requests, production only when allowed', () => {
    expect(changeRequestsLine({ sandbox: true, productionChanges: false })).toBe(
      'Applied here when the person approves them'
    );
    expect(changeRequestsLine({ sandbox: false, productionChanges: false })).toBe(
      'Not in this production org — read only'
    );
    expect(changeRequestsLine({ sandbox: false, productionChanges: true })).toBe(
      'Allowed in this production org'
    );
  });

  it('says in one line what is kept from the assistant', () => {
    expect(keptAway({ ...UAT, hideRestricted: true })).toBe(
      'Case_Note__c (object), Contact.Diagnosis__c, Contact.Ssn__c, fields classified Restricted or Mission Critical'
    );
    expect(keptAway({ excludedObjects: [], excludedFields: [], hideRestricted: false })).toBe(
      'nothing'
    );
  });
});

describe('a new connector', () => {
  it('names the first CRM org Production and does not mark it a sandbox', () => {
    const state = editor({ kind: CRM, existing: null, isFirst: true });
    expect(state.name).toBe('Production');
    expect(state.sandbox).toBe(false);
    expect(state.enabled).toBe(true);
  });

  it('starts every further CRM org as an unnamed sandbox', () => {
    const state = editor({ kind: CRM, existing: null, isFirst: false });
    expect(state.name).toBe('');
    expect(state.sandbox).toBe(true);
  });

  it('starts even the first admin org as a sandbox: building starts there', () => {
    const state = editor({ kind: ADMIN, existing: null, isFirst: true });
    expect(state.name).toBe('');
    expect(state.sandbox).toBe(true);
  });

  it('leaves deleting and reassigning records off by default', () => {
    const { checkedIds } = editor({ kind: CRM, existing: null, isFirst: true });
    expect([...checkedIds].sort()).toEqual(['sf-records-read', 'sf-records-write', 'sf-reports']);
    expect(checkedIds.has('sf-records-delete')).toBe(false);
    expect(checkedIds.has('sf-records-owner')).toBe(false);
  });

  it('leaves assigning user access off by default for an admin connector', () => {
    const { checkedIds } = editor({ kind: ADMIN, existing: null });
    expect([...checkedIds].sort()).toEqual([
      'sfa-layouts',
      'sfa-permissions',
      'sfa-read',
      'sfa-schema',
    ]);
  });

  it('is titled as new, and needs a consumer secret', () => {
    expect(editorTitle(CRM, null)).toBe('New Salesforce connector');
    expect(editorTitle(ADMIN, null)).toBe('New Salesforce Admin connector');
    expect(secretField(null)).toEqual({ required: true, placeholder: '' });
  });

  it('sends what was typed, trimmed, with the checked boxes as scopes and no key', () => {
    const state = editor(
      { kind: CRM, existing: null, isFirst: true },
      typed('myDomain', '  https://acme.my.salesforce.com/lightning/page/home '),
      typed('clientId', ' sf-client '),
      typed('clientSecret', ' sf-secret ')
    );
    const body = saveBody(CRM, null, state);
    expect(body).toEqual({
      name: 'Production',
      myDomain: 'https://acme.my.salesforce.com/lightning/page/home',
      sandbox: false,
      clientId: 'sf-client',
      clientSecret: 'sf-secret',
      enabled: true,
      scopes: expect.any(String),
      excludedObjects: '',
      excludedFields: '',
      hideRestricted: false,
    });
    expect(sortedScopes(body)).toEqual(['sf-records-read', 'sf-records-write', 'sf-reports']);
  });
});

describe('editing a connector', () => {
  it('starts from what is stored, with the secret left blank', () => {
    const state = editor({ kind: CRM, existing: UAT });
    expect(state).toMatchObject({
      name: 'UAT',
      myDomain: UAT.myDomain,
      sandbox: true,
      clientId: 'uat-client',
      clientSecret: '',
      excludedObjects: 'Case_Note__c',
      excludedFields: 'Contact.Diagnosis__c\nContact.Ssn__c',
    });
    expect(editorTitle(CRM, UAT)).toBe('Salesforce · UAT');
  });

  it('checks the boxes its stored ceiling holds, not the defaults', () => {
    const { checkedIds } = editor({ kind: CRM, existing: UAT });
    expect([...checkedIds].sort()).toEqual(['sf-records-read', 'sf-reports']);
  });

  it('falls back to the defaults when no box fits what is stored', () => {
    const { checkedIds } = editor({ kind: CRM, existing: { ...UAT, scopes: 'nothing-known' } });
    expect([...checkedIds].sort()).toEqual(['sf-records-read', 'sf-records-write', 'sf-reports']);
  });

  it('keeps the stored secret when the field is left blank', () => {
    expect(secretField(UAT)).toEqual({
      required: false,
      placeholder: 'Stored — leave blank to keep',
    });
    const body = saveBody(
      CRM,
      UAT,
      editor({ kind: CRM, existing: UAT }, typed('clientSecret', '  '))
    );
    expect(body).not.toHaveProperty('clientSecret');
    expect(body.key).toBe('uat');
  });

  it('asks for a secret again when none is stored', () => {
    expect(secretField({ hasClientSecret: false }).required).toBe(true);
  });

  it('sends the kept-away lists as typed, and the Restricted switch', () => {
    const state = editor(
      { kind: CRM, existing: UAT },
      typed('excludedFields', 'Contact.Diagnosis__c'),
      flagged('hideRestricted', true)
    );
    expect(saveBody(CRM, UAT, state)).toMatchObject({
      excludedObjects: 'Case_Note__c',
      excludedFields: 'Contact.Diagnosis__c',
      hideRestricted: true,
    });
  });

  it('narrows the ceiling when a box is unchecked, and widens it when one is checked', () => {
    const narrowed = editor(
      { kind: CRM, existing: UAT },
      { type: 'toggleOption', optionId: 'sf-reports', on: false },
      { type: 'toggleOption', optionId: 'sf-records-delete', on: true }
    );
    expect(sortedScopes(saveBody(CRM, UAT, narrowed))).toEqual([
      'sf-records-delete',
      'sf-records-read',
    ]);
  });

  it('removes it through its own key', () => {
    expect(removeUrl(CRM, 'full copy')).toBe('/api/admin/connectors/salesforce?key=full%20copy');
    expect(removeUrl(ADMIN, 'uat')).toBe('/api/admin/connectors/salesforce-admin?key=uat');
  });
});

describe('the type’s own sections', () => {
  it('a CRM connector says what it keeps away and has no production switch', () => {
    expect(editorSections(CRM, { sandbox: false })).toEqual({
      productionChanges: false,
      keptAway: true,
    });
  });

  it('an admin connector has no kept-away lists, and offers the switch only for production', () => {
    expect(editorSections(ADMIN, { sandbox: true })).toEqual({
      productionChanges: false,
      keptAway: false,
    });
    expect(editorSections(ADMIN, { sandbox: false })).toEqual({
      productionChanges: true,
      keptAway: false,
    });
  });

  it('a production admin org takes no change requests until someone allows them', () => {
    const production = editor({ kind: ADMIN, existing: null }, flagged('sandbox', false));
    expect(production.productionChanges).toBe(false);
    const body = saveBody(ADMIN, null, production);
    expect(body.productionChanges).toBe(false);
    expect(body).not.toHaveProperty('excludedObjects');
    expect(body).not.toHaveProperty('hideRestricted');
    expect(
      saveBody(ADMIN, null, editorReducer(production, flagged('productionChanges', true)))
    ).toMatchObject({ productionChanges: true });
  });

  it('never sends change requests on for a sandbox, even if it was ticked as production', () => {
    const state = editor(
      { kind: ADMIN, existing: null },
      flagged('sandbox', false),
      flagged('productionChanges', true),
      flagged('sandbox', true)
    );
    expect(saveBody(ADMIN, null, state).productionChanges).toBe(false);
  });
});

describe('saving and removing', () => {
  it('a refused save shows the server’s words and keeps everything typed', () => {
    const state = editor(
      { kind: CRM, existing: null, isFirst: true },
      typed('myDomain', 'login.salesforce.com'),
      typed('clientSecret', 'secret'),
      { type: 'sent' },
      { type: 'failed', error: 'My Domain must be the org’s own' }
    );
    expect(state).toMatchObject({
      busy: false,
      error: 'My Domain must be the org’s own',
      myDomain: 'login.salesforce.com',
      clientSecret: 'secret',
    });
  });

  it('sending again clears the last refusal while it is in flight', () => {
    const state = editor(
      { kind: CRM, existing: null },
      { type: 'failed', error: 'is already the Production connector' },
      { type: 'sent' }
    );
    expect(state).toMatchObject({ busy: true, error: null, notice: null });
  });

  it('a saved connector says Saved and forgets the secret typed', () => {
    const state = editor(
      { kind: CRM, existing: UAT },
      typed('clientSecret', 'new-secret'),
      { type: 'sent' },
      { type: 'saved' }
    );
    expect(state).toMatchObject({ busy: false, notice: 'Saved', clientSecret: '' });
  });

  it('Remove asks first, and Keep it backs out', () => {
    const armed = editor({ kind: CRM, existing: UAT }, { type: 'armRemove' });
    expect(armed.confirmingRemove).toBe(true);
    expect(editorReducer(armed, { type: 'disarmRemove' }).confirmingRemove).toBe(false);
  });

  it('a refused remove says so', () => {
    const state = editor(
      { kind: CRM, existing: UAT },
      { type: 'armRemove' },
      { type: 'sent' },
      { type: 'failed', error: 'Could not remove it' }
    );
    expect(state).toMatchObject({ busy: false, error: 'Could not remove it' });
  });
});
