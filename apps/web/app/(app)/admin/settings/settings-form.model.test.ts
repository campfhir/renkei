import {
  byteSizeField,
  canSave,
  gbToBytes,
  initSettings,
  isActApprovalPolicy,
  isDirty,
  isLogLevel,
  mbToBytes,
  saveLabel,
  saveRequest,
  settingsReducer,
  showsUnsaved,
  toGb,
  toMb,
  typedBytes,
  type EditableSettings,
  type SettingsAction,
  type SettingsState,
} from './settings-form.model';

const GB = 1_073_741_824;
const MB = 1_048_576;

/** The organization as a fresh deployment stores it. */
const STORED: EditableSettings = {
  organizationName: 'Renkei',
  readOnly: false,
  coachMarksEnabled: true,
  phiConnectorsRequireCoveredModel: false,
  artifactDigestEnabled: false,
  enableDcr: false,
  sandboxBrowserEnabled: true,
  sandboxChartsEnabled: true,
  sandboxWorkspacesEnabled: true,
  sandboxServicesEnabled: true,
  sandboxScriptsEnabled: false,
  sandboxScriptsAllowNetwork: false,
  logLevel: 'info',
  maxJqlResults: 100,
  maxAttachmentBytes: 20 * MB,
  massUploadThreshold: 20,
  rateLimitPerUserPerMinute: 120,
  accessTokenTtlMinutes: 60,
  authorizationCodeTtlSeconds: 120,
  refreshTokenTtlDays: 30,
  sessionIdleTimeoutMinutes: 720,
  agentMaxChainDepth: 3,
  agentRunTimeoutMinutes: 30,
  agentRunToolCallBudget: 150,
  agentMaxRunsPerDay: 1000,
  agentApprovalMaxWaitDays: 14,
  agentActStepsRequireApproval: 'externally_triggered',
  contentPollMinutes: 30,
  webexWebhookHealthMinutes: 60,
  logRetentionDays: 90,
  agentNotificationRetentionDays: 90,
  agentUsageRetentionDays: 365,
  chatRetentionDays: 365,
  agentOptimizerWindowDays: 30,
  knowledgeKeywordEnrichment: false,
  knowledgeKeywordMinChars: 400,
  chatReplyPresenceWindowSeconds: 20,
  sandboxWorkspaceMaxBytes: 8 * GB,
  sandboxScriptMemoryBytes: 2 * GB,
  sandboxServiceMemoryBytes: 1 * GB,
  sandboxServicePids: 512,
  sandboxWorkspacesDebug: false,
  admanagerProductName: 'Renkei',
};

function run(...actions: SettingsAction[]): SettingsState {
  return actions.reduce(settingsReducer, initSettings(STORED));
}

const change = (patch: Partial<EditableSettings>): SettingsAction => ({ type: 'changed', patch });

describe('the settings form', () => {
  it('opens with nothing to save: Save is off and nothing says "Unsaved changes"', () => {
    const state = run();
    expect(isDirty(state)).toBe(false);
    expect(canSave(state)).toBe(false);
    expect(showsUnsaved(state)).toBe(false);
    expect(saveLabel(state)).toBe('Save settings');
  });

  it('renaming the organization turns Save on and says there are unsaved changes', () => {
    const state = run(change({ organizationName: 'Acme Health' }));
    expect(canSave(state)).toBe(true);
    expect(showsUnsaved(state)).toBe(true);
  });

  it('typing a value back to what is stored leaves nothing to save', () => {
    const state = run(change({ readOnly: true }), change({ readOnly: false }));
    expect(canSave(state)).toBe(false);
    expect(saveRequest(state)).toEqual({});
  });

  it('Save sends only what this form changed, not another operator’s settings', () => {
    const state = run(
      change({ organizationName: '  Acme Health  ' }),
      change({ phiConnectorsRequireCoveredModel: true }),
      change({ agentActStepsRequireApproval: 'all' })
    );
    expect(saveRequest(state)).toEqual({
      organizationName: '  Acme Health  ',
      phiConnectorsRequireCoveredModel: true,
      agentActStepsRequireApproval: 'all',
    });
  });

  it('turning charts off sends that one switch', () => {
    expect(saveRequest(run(change({ sandboxChartsEnabled: false })))).toEqual({
      sandboxChartsEnabled: false,
    });
  });

  it('while saving, Save is off, reads "Saving…", and "Unsaved changes" is hidden', () => {
    const state = run(change({ readOnly: true }), { type: 'sent' });
    expect(canSave(state)).toBe(false);
    expect(saveLabel(state)).toBe('Saving…');
    expect(showsUnsaved(state)).toBe(false);
  });

  it('a stored save adopts the server’s answer, clamps included, and says "Saved."', () => {
    const clamped = { ...STORED, organizationName: 'Acme Health', sandboxServicePids: 16 };
    const state = run(
      change({ organizationName: '  Acme Health  ', sandboxServicePids: 1 }),
      { type: 'sent' },
      { type: 'stored', settings: clamped }
    );
    expect(state.values).toEqual(clamped);
    expect(state.phase).toBe('saved');
    expect(isDirty(state)).toBe(false);
    expect(canSave(state)).toBe(false);
  });

  it('the next change after a save takes "Saved." away and diffs against what was stored', () => {
    const stored = { ...STORED, agentActStepsRequireApproval: 'all' as const };
    const state = run(
      change({ agentActStepsRequireApproval: 'all' }),
      { type: 'sent' },
      { type: 'stored', settings: stored },
      change({ readOnly: true })
    );
    expect(state.phase).toBe('idle');
    expect(saveRequest(state)).toEqual({ readOnly: true });
  });

  it('a refused save keeps the edits, shows the server’s words and lets the person try again', () => {
    const state = run(
      change({ organizationName: '   ' }),
      { type: 'sent' },
      {
        type: 'failed',
        error: 'organizationName must be a name',
      }
    );
    expect(state.error).toBe('organizationName must be a name');
    expect(state.values.organizationName).toBe('   ');
    expect(canSave(state)).toBe(true);
    expect(showsUnsaved(state)).toBe(true);
  });

  it('a save that failed without words says "Save failed"', () => {
    expect(
      run(change({ readOnly: true }), { type: 'sent' }, { type: 'failed', error: null }).error
    ).toBe('Save failed');
  });

  it('the error stays while the person edits, and goes when the next save is sent', () => {
    const failed = run(
      change({ readOnly: true }),
      { type: 'sent' },
      { type: 'failed', error: 'No' }
    );
    const edited = settingsReducer(failed, change({ enableDcr: true }));
    expect(edited.error).toBe('No');
    expect(settingsReducer(edited, { type: 'sent' }).error).toBeNull();
  });
});

describe('the size fields', () => {
  it('the checkout limit shows whole gigabytes and stores bytes', () => {
    expect(toGb(8 * GB)).toBe(8);
    expect(gbToBytes('12')).toBe(12 * GB);
  });

  it('memory ceilings show megabytes and store bytes', () => {
    expect(toMb(1 * GB)).toBe(1024);
    expect(mbToBytes('1536')).toBe(1536 * MB);
    expect(saveRequest(run(change({ sandboxServiceMemoryBytes: mbToBytes('1536') })))).toEqual({
      sandboxServiceMemoryBytes: 1536 * MB,
    });
  });

  it('the attachment size shows in the largest unit it divides into', () => {
    expect(byteSizeField(null, 20 * MB)).toEqual({ text: '20MB', invalid: false });
  });

  it('a half-typed size keeps the typing, is marked invalid and stores nothing', () => {
    expect(byteSizeField('70M', 20 * MB)).toEqual({ text: '70M', invalid: true });
    expect(typedBytes('70M')).toBeNull();
  });

  it('a size with a unit stores its bytes', () => {
    expect(typedBytes('70MB')).toBe(70 * MB);
    expect(typedBytes('2 GB')).toBe(2 * GB);
    expect(byteSizeField('70MB', 70 * MB).invalid).toBe(false);
  });
});

describe('the pick lists', () => {
  it('offer only the log levels and approval policies the server knows', () => {
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
    expect(isActApprovalPolicy('off')).toBe(true);
    expect(isActApprovalPolicy('sometimes')).toBe(false);
  });
});
