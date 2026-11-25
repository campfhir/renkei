import { createMemoryDataStore, getDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  NO_PROJECT_TOOL_SETTINGS,
  parseProjectToolSettings,
  rememberProjectToolRule,
  withProjectToolRule,
} from './project-permissions';

describe('a project’s tool settings for its chats', () => {
  it('reads what was stored; a name on both lists asks', () => {
    expect(parseProjectToolSettings(null)).toEqual(NO_PROJECT_TOOL_SETTINGS);
    expect(parseProjectToolSettings({ allow: ['b', 'a', 'no name'], ask: ['b'] })).toEqual({
      allow: ['a'],
      ask: ['b'],
    });
  });

  it('moves a tool between Allow and Ask, and clears it', () => {
    const allowed = withProjectToolRule(NO_PROJECT_TOOL_SETTINGS, 'jira_create_issue', 'allow');
    expect(withProjectToolRule(allowed, 'jira_create_issue', 'ask')).toEqual({
      allow: [],
      ask: ['jira_create_issue'],
    });
    expect(withProjectToolRule(allowed, 'jira_create_issue', 'clear')).toEqual(
      NO_PROJECT_TOOL_SETTINGS
    );
  });

  it('is kept on the project', async () => {
    registerDataStore(createMemoryDataStore());
    try {
      const projectId = await getDataStore().chatProjects.create({
        ownerSubject: 'ann',
        name: 'Sprint',
        description: null,
        toolConfig: null,
      });
      expect(await rememberProjectToolRule(projectId, 'jira_search', 'ask')).toEqual({
        allow: [],
        ask: ['jira_search'],
      });
      expect(
        parseProjectToolSettings(
          (await getDataStore().chatProjects.get(projectId))?.toolPermissions
        )
      ).toEqual({ allow: [], ask: ['jira_search'] });
      await rememberProjectToolRule(projectId, 'jira_search', 'clear');
      expect((await getDataStore().chatProjects.get(projectId))?.toolPermissions).toBeNull();
    } finally {
      resetDataStore();
    }
  });
});
