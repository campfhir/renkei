import { clampStage, STAGE_MAX_LENGTH } from './turns';

describe('clampStage', () => {
  it('leaves a stage that fits the column alone', () => {
    expect(clampStage('tool:jira_search')).toBe('tool:jira_search');
    expect(clampStage(null)).toBeNull();
  });

  it('shortens a parallel tool group so the heartbeat write cannot overflow varchar(64)', () => {
    const stage = `tool:${['jsm_add_request_participant_preview', 'jsm_get_request', 'agent_runs_list'].join(',')}`;
    const clamped = clampStage(stage);
    expect(clamped).not.toBeNull();
    expect(clamped!.length).toBe(STAGE_MAX_LENGTH);
    expect(stage.startsWith(clamped!.slice(0, -1))).toBe(true);
  });
});
