/**
 * Space templates as documents: what a template keeps of a space (never
 * the people), what it reads back, and how a live space is compared to it.
 */

jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import type { SpaceConfiguration } from './space-config';
import { documentFromSpace, readTemplateDocument, templateDifferences } from './space-templates';

const OPS: SpaceConfiguration = {
  id: '10000',
  key: 'OPS',
  name: 'Operations',
  projectTypeKey: 'software',
  assigneeType: 'UNASSIGNED',
  category: { id: '10100', name: 'Internal' },
  lead: { accountId: 'acct-lead', displayName: 'Lee Lead' },
  schemes: {
    issueTypeScheme: { id: '11', name: 'OPS work types' },
    issueTypeScreenScheme: { id: '12', name: 'OPS screens' },
    workflowScheme: { id: '13', name: 'OPS workflows' },
    fieldConfigurationScheme: null,
    permissionScheme: { id: '15', name: 'Internal permissions' },
    notificationScheme: { id: '16', name: 'Quiet notifications' },
    issueSecurityScheme: null,
  },
  roles: [
    {
      roleId: '10002',
      roleName: 'Administrators',
      groups: [{ groupId: 'g-admins', name: 'ops-admins' }],
      users: [{ accountId: 'acct-dana', displayName: 'Dana Admin' }],
    },
  ],
  components: [
    {
      id: '20000',
      name: 'Backend',
      description: 'Services and jobs',
      assigneeType: 'COMPONENT_LEAD',
      lead: { accountId: 'acct-dana', displayName: 'Dana Admin' },
    },
    { id: '20001', name: 'Reports', description: null, assigneeType: 'PROJECT_LEAD', lead: null },
  ],
};

describe('the template document', () => {
  it('keeps the schemes, facts, role groups and components, and never the people', () => {
    const document = documentFromSpace(OPS);
    expect(document).toEqual({
      version: 1,
      projectTypeKey: 'software',
      assigneeType: 'UNASSIGNED',
      category: { id: '10100', name: 'Internal' },
      schemes: OPS.schemes,
      roles: [
        {
          roleId: '10002',
          roleName: 'Administrators',
          groups: [{ groupId: 'g-admins', name: 'ops-admins' }],
        },
      ],
      // No component leads: Backend's issues fall to the space's default.
      components: [
        { name: 'Backend', description: 'Services and jobs', assigneeType: 'PROJECT_DEFAULT' },
        { name: 'Reports', description: null, assigneeType: 'PROJECT_LEAD' },
      ],
    });
    expect(JSON.stringify(document)).not.toContain('acct-dana');
  });

  it('reads back only a document it wrote, with the two schemes that may be absent', () => {
    const document = documentFromSpace(OPS);
    expect(readTemplateDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
    expect(readTemplateDocument({ ...document, version: 2 })).toBeNull();
    expect(
      readTemplateDocument({
        ...document,
        schemes: { ...document.schemes, permissionScheme: null },
      })
    ).toBeNull();
  });

  it('reads a template saved before components were kept as not knowing them', () => {
    const { components: _dropped, ...older } = documentFromSpace(OPS);
    expect(readTemplateDocument(JSON.parse(JSON.stringify(older)))?.components).toBeNull();
  });
});

describe('comparing a space to a template', () => {
  const template = documentFromSpace(OPS);

  it('finds nothing to report for the space it was saved from', () => {
    expect(templateDifferences(template, OPS)).toEqual([]);
  });

  it('reports each drifted scheme, fact and role group in plain words', () => {
    const drifted: SpaceConfiguration = {
      ...OPS,
      key: 'FIN',
      assigneeType: 'PROJECT_LEAD',
      category: null,
      schemes: {
        ...OPS.schemes,
        workflowScheme: { id: '99', name: 'Finance workflows' },
        issueSecurityScheme: { id: '17', name: 'Confidential' },
      },
      roles: [
        {
          roleId: '10002',
          roleName: 'Administrators',
          groups: [{ groupId: 'g-fin', name: 'fin-admins' }],
          users: [],
        },
      ],
      components: [
        { id: '30000', name: 'backend', description: null, assigneeType: 'UNASSIGNED', lead: null },
        { id: '30001', name: 'Ledger', description: null, assigneeType: 'UNASSIGNED', lead: null },
      ],
    };
    expect(templateDifferences(template, drifted)).toEqual([
      'Workflows: the template has “OPS workflows”, FIN has “Finance workflows”.',
      'Issue security: the template has none, FIN has “Confidential”.',
      'Default assignee: the template has UNASSIGNED, FIN has PROJECT_LEAD.',
      'Category: the template has “Internal”, FIN has none.',
      'Administrators: FIN is missing group “ops-admins”.',
      'Administrators: FIN also has group “fin-admins”, which the template does not.',
      // By name, ignoring case: "backend" is Backend.
      'Components: FIN is missing “Reports”.',
      'Components: FIN also has “Ledger”, which the template does not.',
    ]);
  });

  it('does not compare components against a template that never kept them', () => {
    expect(
      templateDifferences({ ...template, components: null }, { ...OPS, components: [] })
    ).toEqual([]);
  });
});
