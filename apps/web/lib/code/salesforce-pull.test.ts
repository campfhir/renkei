/**
 * code_salesforce_pull against a scripted Salesforce and sandbox: the
 * person's admin connection is asked for the named components, the zip
 * Salesforce answers with goes into the checkout and is converted there,
 * and the answer says what came back and that nothing is committed. A
 * selection that is not one, an org the person cannot reach, a retrieve
 * Salesforce fails and a conversion that fails each stop it in words —
 * and nothing is uploaded unless there is a zip.
 */

jest.mock('@renkei/sandbox-client', () => ({
  sbWorkspaceUpload: jest.fn(),
  sbWorkspaceExec: jest.fn(),
}));
jest.mock('@/lib/mcp-tools/salesforce/client', () => ({ resolveSalesforceAccess: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));

import { countByType, salesforcePullTools } from './salesforce-pull';
import { orgCall } from '@/lib/mcp-tools/salesforce/org-choice';
import { errorResult, type LocalToolContext } from '@/lib/chat/local-tools';
import type { McpToolResult } from '@renkei/mcp-client';
import { resourceCipher } from '@/lib/chat/content-crypto';

const sandbox = jest.requireMock<{ sbWorkspaceUpload: jest.Mock; sbWorkspaceExec: jest.Mock }>(
  '@renkei/sandbox-client'
);
const salesforce = jest.requireMock<{ resolveSalesforceAccess: jest.Mock }>(
  '@/lib/mcp-tools/salesforce/client'
);
const audit = jest.requireMock<{ recordAuditEvent: jest.Mock }>('@/lib/audit-events');

const context: LocalToolContext = {
  subject: 'auth0|ada',
  chatId: 'chat-1',
  cipher: resourceCipher({ id: '00000000-0000-4000-8000-00000000c1fe', key: Buffer.alloc(32, 7) }),
  projectId: 'p1',
  userEmail: 'ada@example.com',
  readOnly: false,
};

const envelope = (body: string) =>
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
const STARTED = envelope(
  '<retrieveResponse><result><done>false</done><id>09S5e000001AbCdEAK</id></result></retrieveResponse>'
);
const RUNNING = envelope(
  '<checkRetrieveStatusResponse><result><done>false</done><status>InProgress</status></result></checkRetrieveStatusResponse>'
);
const ZIP = Buffer.from('PK-a-zip');
const DONE = envelope(
  '<checkRetrieveStatusResponse><result><done>true</done>' +
    '<fileProperties><fullName>Visit__c</fullName><type>CustomObject</type></fileProperties>' +
    '<fileProperties><fullName>Hello</fullName><type>ApexClass</type></fileProperties>' +
    '<fileProperties><fullName>package.xml</fullName><type>Package</type></fileProperties>' +
    '<messages><problem>Entity of type &apos;ApexClass&apos; named &apos;Gone&apos; cannot be found</problem></messages>' +
    `<success>true</success><zipFile>${ZIP.toString('base64')}</zipFile></result></checkRetrieveStatusResponse>`
);

/** A Salesforce that answers each SOAP call with the next scripted answer, and keeps what it was sent. */
function org(answers: string[]) {
  const sent: { url: string; body: string }[] = [];
  const auth = jest.fn(async (url: string, init: { body: string }) => {
    sent.push({ url, body: init.body });
    return new Response(answers.shift() ?? RUNNING, { status: 200 });
  });
  salesforce.resolveSalesforceAccess.mockImplementation(async () => {
    seenCall = orgCall.getStore();
    return {
      auth,
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      connector: 'uat',
      connectorName: 'Acme UAT',
      sandbox: true,
    };
  });
  return sent;
}
let seenCall: { org?: string; tool: string } | undefined;

const failed = jest.fn(() => errorResult('sandbox failed'));
function tool() {
  return salesforcePullTools({
    target: { subject: 'auth0|ada' },
    ref: { id: 'ws-1' },
    repoFullName: 'acme/crm',
    failed,
    wait: async () => undefined,
  })[0];
}
const textOf = (result: McpToolResult) => result.content.map((part) => part.text ?? '').join('\n');
const COMPONENTS = [
  { type: 'CustomObject', members: ['Visit__c'] },
  { type: 'ApexClass', members: ['Hello', 'Gone'] },
];

beforeEach(() => {
  jest.clearAllMocks();
  seenCall = undefined;
  sandbox.sbWorkspaceUpload.mockResolvedValue({ ok: true, val: { path: 'x', created: true } });
  sandbox.sbWorkspaceExec.mockResolvedValue({
    ok: true,
    val: { exitCode: 0, stdout: 'Converting 2 metadata components... done', stderr: '' },
  });
});

describe('code_salesforce_pull', () => {
  it('pulls the named components on the person’s admin connection and converts them in the checkout', async () => {
    const sent = org([STARTED, RUNNING, DONE]);
    const result = await tool().execute({ org: 'uat', components: COMPONENTS }, context);

    // The org asked for, on the admin connector, for reading.
    expect(seenCall).toEqual({ org: 'uat', tool: 'code_salesforce_pull' });
    const [, kind, scopeFor] = salesforce.resolveSalesforceAccess.mock.calls[0];
    expect(kind.key).toBe('salesforce-admin');
    expect(scopeFor('code_salesforce_pull')).toEqual(['sfa-read']);

    // Three calls to the Metadata SOAP endpoint: the manifest, then the retrieve's id twice.
    expect(sent.map((call) => call.url)).toEqual(
      Array(3).fill('https://acme--uat.sandbox.my.salesforce.com/services/Soap/m/68.0')
    );
    expect(sent[0].body).toBe(
      '<retrieve xmlns="http://soap.sforce.com/2006/04/metadata"><types><name>CustomObject</name><members>Visit__c</members></types><types><name>ApexClass</name><members>Hello</members><members>Gone</members></types></retrieve>'
    );
    expect(sent[1].body).toContain('<asyncProcessId>09S5e000001AbCdEAK</asyncProcessId>');

    // The zip as Salesforce sent it goes into this chat's checkout, and one command converts and removes it.
    const [, upload] = sandbox.sbWorkspaceUpload.mock.calls[0];
    expect(upload.id).toBe('ws-1');
    expect(Buffer.from(upload.bytes).equals(ZIP)).toBe(true);
    const [, exec] = sandbox.sbWorkspaceExec.mock.calls[0];
    expect(exec.id).toBe('ws-1');
    expect(exec.command).toContain(`zip=${upload.path}`);
    // SHELL is exported before the CLI runs: a sandbox on an earlier build does not set it.
    expect(exec.command.indexOf('export SHELL=/bin/sh')).toBeGreaterThan(-1);
    expect(exec.command.indexOf('export SHELL=/bin/sh')).toBeLessThan(
      exec.command.indexOf('sf project convert mdapi')
    );
    expect(exec.command).toContain('sf project convert mdapi');
    expect(exec.command).toContain('trap \'rm -rf "$zip" "$dir"\' EXIT');
    expect(exec.command).not.toMatch(/sf org login|deploy/);

    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain('Pulled 2 component(s) from Acme UAT (a sandbox)');
    expect(text).toContain('ApexClass 1, CustomObject 1');
    expect(text).toContain("- Entity of type 'ApexClass' named 'Gone' cannot be found");
    expect(text).toContain('Converting 2 metadata components... done');
    expect(text).toContain('Nothing is committed');

    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubject: 'auth0|ada',
        action: 'code.salesforce.pulled',
        targetLabel: 'acme/crm',
        details: expect.objectContaining({
          org: 'uat',
          components: 2,
          types: [
            { type: 'CustomObject', members: 1 },
            { type: 'ApexClass', members: 2 },
          ],
        }),
      })
    );
  });

  it('refuses a selection that is not one before asking for a connection', async () => {
    org([]);
    const result = await tool().execute(
      { components: [{ type: 'CustomObject', members: ['<b>'] }] },
      context
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not a CustomObject member/);
    expect(salesforce.resolveSalesforceAccess).not.toHaveBeenCalled();
  });

  it('says why when the person has no connection to the org, and touches nothing', async () => {
    salesforce.resolveSalesforceAccess.mockResolvedValue(
      'Salesforce Admin Acme UAT is not connected. Connect it on the Connectors page, then try again.'
    );
    const result = await tool().execute({ components: COMPONENTS }, context);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('is not connected');
    expect(seenCall).toBeUndefined();
    expect(sandbox.sbWorkspaceUpload).not.toHaveBeenCalled();
  });

  it('a retrieve Salesforce fails uploads nothing and says why', async () => {
    org([
      STARTED,
      envelope(
        '<checkRetrieveStatusResponse><result><done>true</done><errorMessage>LIMIT_EXCEEDED: Too many files</errorMessage><success>false</success></result></checkRetrieveStatusResponse>'
      ),
    ]);
    const result = await tool().execute({ components: COMPONENTS }, context);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('LIMIT_EXCEEDED: Too many files');
    expect(sandbox.sbWorkspaceUpload).not.toHaveBeenCalled();
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it('a fault starting the retrieve is reported as Salesforce’s own words', async () => {
    org([
      envelope(
        '<soapenv:Fault><faultstring>INVALID_TYPE: Unknown type name &apos;Nope&apos;</faultstring></soapenv:Fault>'
      ),
    ]);
    const result = await tool().execute({ components: COMPONENTS }, context);
    expect(textOf(result)).toContain("INVALID_TYPE: Unknown type name 'Nope'");
  });

  it('a conversion that fails is an error carrying the command’s output, and is not audited as a pull', async () => {
    org([STARTED, DONE]);
    sandbox.sbWorkspaceExec.mockResolvedValue({
      ok: true,
      val: { exitCode: 1, stdout: '', stderr: 'Error (MissingPackageDirectoryError)' },
    });
    const result = await tool().execute({ components: COMPONENTS }, context);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('turning them into source failed');
    expect(textOf(result)).toContain('MissingPackageDirectoryError');
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it('writes nothing while the organization is read-only', async () => {
    org([STARTED, DONE]);
    const result = await tool().execute({ components: COMPONENTS }, { ...context, readOnly: true });
    expect(result.isError).toBe(true);
    expect(salesforce.resolveSalesforceAccess).not.toHaveBeenCalled();
  });
});

describe('countByType', () => {
  it('counts each type, most first, ties by name', () => {
    expect(
      countByType([{ type: 'Layout' }, { type: 'ApexClass' }, { type: 'Layout' }, { type: 'Aura' }])
    ).toBe('Layout 2, ApexClass 1, Aura 1');
  });
});
