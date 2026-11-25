import {
  initialProjectToolSettingsState,
  projectPickerGroups,
  projectRuleOptions,
  projectSave,
  projectToolRows,
  projectToolSettingsReducer,
  type ProjectToolSettingsAction,
} from './project-tool-settings.model';

const TOOLS = [
  {
    key: 'jira',
    label: 'Jira',
    tools: [
      { name: 'jira_create_issue', label: 'Create an issue' },
      { name: 'jira_search', label: 'Search', read: true },
    ],
  },
  { key: 'outlook', label: 'Outlook', tools: [{ name: 'outlook_send_mail', label: 'Send mail' }] },
];
const answer = (
  settings: { allow: string[]; ask: string[] },
  extra: Record<string, unknown> = {}
) => ({
  settings,
  locked: [],
  tools: TOOLS,
  canEdit: true,
  ...extra,
});
const fold = (...actions: ProjectToolSettingsAction[]) =>
  actions.reduce(projectToolSettingsReducer, initialProjectToolSettingsState);

describe('a project’s tool permissions', () => {
  it('lists what asks first, then what is allowed, in the catalog’s words', () => {
    const state = fold({
      type: 'loaded',
      answer: answer({ allow: ['jira_create_issue'], ask: ['jira_search'] }),
    });
    expect(projectToolRows(state).map((row) => [row.label, row.tag.text])).toEqual([
      ['Search', 'Asks'],
      ['Create an issue', 'Allowed'],
    ]);
  });

  it('an allowed tool the organization locks says it still asks', () => {
    const [row] = projectToolRows(
      fold({
        type: 'loaded',
        answer: answer(
          { allow: ['outlook_send_mail'], ask: [] },
          { locked: ['outlook_send_mail'] }
        ),
      })
    );
    expect(row.tag.text).toBe('Locked · asks');
  });

  it('someone who can only view sees the rows, every Reset off', () => {
    const rows = projectToolRows(
      fold({
        type: 'loaded',
        answer: answer({ allow: ['jira_create_issue'], ask: [] }, { canEdit: false }),
      })
    );
    expect(rows.every((row) => row.disabled)).toBe(true);
  });

  it('Set a tool: Allow and Ask for one that acts, Ask alone for one that reads or is locked', () => {
    const loaded: ProjectToolSettingsAction = {
      type: 'loaded',
      answer: answer({ allow: [], ask: [] }, { locked: ['outlook_send_mail'] }),
    };
    const pick = (tool: string) =>
      fold(loaded, { type: 'picker-opened' }, { type: 'picker-select', tool });
    expect(projectRuleOptions(pick('jira_create_issue')).map((option) => option.label)).toEqual([
      'Allow',
      'Ask',
    ]);
    expect(projectRuleOptions(pick('jira_search')).map((option) => option.label)).toEqual(['Ask']);
    expect(projectRuleOptions(pick('outlook_send_mail')).map((option) => option.label)).toEqual([
      'Ask',
    ]);
  });

  it('Save is off until a tool and a choice are picked; a save closes the dialog', () => {
    const open = fold(
      { type: 'loaded', answer: answer({ allow: [], ask: [] }) },
      { type: 'picker-opened' }
    );
    expect(projectSave(open).disabled).toBe(true);
    const choose: ProjectToolSettingsAction[] = [
      { type: 'picker-select', tool: 'jira_create_issue' },
      { type: 'picker-rule', rule: 'allow' },
    ];
    const picked = choose.reduce(projectToolSettingsReducer, open);
    expect(projectSave(picked)).toEqual({ disabled: false, label: 'Save' });
    const saving: ProjectToolSettingsAction[] = [
      { type: 'change-started', tool: 'jira_create_issue' },
      { type: 'change-succeeded', answer: answer({ allow: ['jira_create_issue'], ask: [] }) },
    ];
    const saved = saving.reduce(projectToolSettingsReducer, picked);
    expect(saved.picker.open).toBe(false);
    expect(projectToolRows(saved).map((row) => row.name)).toEqual(['jira_create_issue']);
  });

  it('the search narrows by tool or connector', () => {
    const state = fold(
      { type: 'loaded', answer: answer({ allow: [], ask: [] }) },
      { type: 'picker-opened' },
      { type: 'picker-filter', filter: 'outlook' }
    );
    expect(projectPickerGroups(state).map((group) => group.key)).toEqual(['outlook']);
  });
});
