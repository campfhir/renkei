import {
  dataHandlingOf,
  dataHandlingWarning,
  DEFAULT_DATA_HANDLING,
  phiCoveredModelRefusal,
} from './data-handling';

describe('dataHandlingOf', () => {
  it('defaults to unknown retention and no BAA when settings say nothing', () => {
    expect(dataHandlingOf(null)).toEqual(DEFAULT_DATA_HANDLING);
    expect(dataHandlingOf({})).toEqual(DEFAULT_DATA_HANDLING);
    expect(dataHandlingOf({ maxOutputTokens: 4 })).toEqual(DEFAULT_DATA_HANDLING);
  });

  it('reads the four fields, trimming text and refusing an unknown retention word', () => {
    expect(
      dataHandlingOf({
        dataResidency: '  Azure East US, DataZone ',
        providerRetention: 'abuse-monitoring',
        baaCovered: true,
        notes: 'Signed 2026-01',
      })
    ).toEqual({
      dataResidency: 'Azure East US, DataZone',
      providerRetention: 'abuse-monitoring',
      baaCovered: true,
      notes: 'Signed 2026-01',
    });
    expect(dataHandlingOf({ providerRetention: 'forever', baaCovered: 'yes' })).toEqual(
      DEFAULT_DATA_HANDLING
    );
  });

  it('flags a row without a BAA first, then one whose retention is unstated', () => {
    expect(dataHandlingWarning(DEFAULT_DATA_HANDLING)).toBe('Not BAA-covered');
    expect(dataHandlingWarning({ ...DEFAULT_DATA_HANDLING, baaCovered: true })).toBe(
      'Retention unknown'
    );
    expect(
      dataHandlingWarning({ ...DEFAULT_DATA_HANDLING, baaCovered: true, providerRetention: 'none' })
    ).toBeNull();
  });
});

describe('phiCoveredModelRefusal', () => {
  const uncovered = { model: 'gpt-6-astra-1', dataHandling: DEFAULT_DATA_HANDLING };
  const covered = {
    model: 'claude-sonnet-5',
    dataHandling: { ...DEFAULT_DATA_HANDLING, baaCovered: true },
  };

  it('is silent while the setting is off, whatever the tools and model', () => {
    expect(phiCoveredModelRefusal(false, ['mirth_get_message'], uncovered)).toBeNull();
  });

  it('refuses an uncovered model only when a PHI connector is in reach, naming both', () => {
    expect(
      phiCoveredModelRefusal(true, ['jira_get_issue', 'outlook_send_mail'], uncovered)
    ).toBeNull();
    const refusal = phiCoveredModelRefusal(
      true,
      ['jira_get_issue', 'onbase_read_document', 'fileshare_read_file'],
      uncovered
    );
    expect(refusal).toContain('OnBase, file shares');
    expect(refusal).toContain('"gpt-6-astra-1"');
    // A resolved model from before the field existed reads as uncovered.
    expect(phiCoveredModelRefusal(true, ['mirth_search_messages'], { model: 'm' })).toContain(
      'Mirth'
    );
  });

  it('lets a BAA-covered model through', () => {
    expect(phiCoveredModelRefusal(true, ['mirth_get_message'], covered)).toBeNull();
  });
});
