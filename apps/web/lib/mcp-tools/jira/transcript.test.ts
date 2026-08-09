import {
  analyzeTranscript,
  detectMeeting,
  formatActionsAsMarkdown,
  isMeetingType,
  type TranscriptOptions,
} from './transcript';

const actionsOf = (transcript: string, options: TranscriptOptions = {}) =>
  analyzeTranscript(transcript, options).actions;

const forTool = (transcript: string, tool: string, options: TranscriptOptions = {}) =>
  actionsOf(transcript, options).filter((action) => action.tool === tool);

describe('analyzeTranscript', () => {
  it('finds nothing in empty or unremarkable input', () => {
    expect(actionsOf('')).toEqual([]);
    expect(actionsOf('   ')).toEqual([]);
    expect(actionsOf('We talked about the weather and then adjourned.')).toEqual([]);
  });

  describe('issue creation', () => {
    it('picks up the summary and the issue type from the noun used', () => {
      const [action] = forTool('Can we create a bug for the login timeout?', 'jira_create_issue');
      expect(action?.arguments.issueType).toBe('Bug');
      expect(action?.arguments.summary).toBe('the login timeout');
    });

    it('defaults to Task and quotes the transcript in the description', () => {
      const [action] = forTool(
        'We need to create a task: rotate the signing keys',
        'jira_create_issue'
      );
      expect(action?.arguments.issueType).toBe('Task');
      expect(action?.arguments.summary).toBe('rotate the signing keys');
      expect(action?.arguments.description).toContain('rotate the signing keys');
    });

    it('fills in the project when given one, and is honest when not', () => {
      const [withProject] = forTool('create a task: ship it', 'jira_create_issue', {
        projectKey: 'CHG',
      });
      expect(withProject?.arguments.projectKey).toBe('CHG');
      expect(withProject?.confidence).toBe('high');

      const [without] = forTool('create a task: ship it', 'jira_create_issue');
      expect(without?.arguments).not.toHaveProperty('projectKey');
      expect(without?.confidence).toBe('medium');
      expect(without?.summary).toContain('project not named');
    });
  });

  describe('assignment', () => {
    it('reads "assign KEY to person"', () => {
      const [action] = forTool('Please assign CHG-20 to dana.lin', 'jira_update_issue');
      expect(action?.arguments).toEqual({ issueKey: 'CHG-20', assignee: 'dana.lin' });
      expect(action?.confidence).toBe('high');
    });

    it('reads "person will handle KEY", in either order', () => {
      const [action] = forTool('dana will handle CHG-21 this sprint', 'jira_update_issue');
      expect(action?.arguments).toEqual({ issueKey: 'CHG-21', assignee: 'dana' });
    });

    it('reads an "assign: person for KEY" line', () => {
      const [action] = forTool('assign: sam@x.test for ENG-5', 'jira_update_issue');
      expect(action?.arguments).toEqual({ issueKey: 'ENG-5', assignee: 'sam@x.test' });
    });

    it('works for any project key, not just SCRUM', () => {
      // The original patterns hardcoded SCRUM and captured no key, so this
      // produced nothing at all.
      const keys = forTool('assign ABC_9-1234 to dana', 'jira_update_issue').map(
        (action) => action.arguments.issueKey
      );
      expect(keys).toEqual(['ABC_9-1234']);
    });
  });

  describe('transitions', () => {
    it('normalises a spoken status to a Jira name', () => {
      const [action] = forTool('move CHG-20 to in progress', 'jira_transition_issue');
      expect(action?.arguments).toEqual({ issueKey: 'CHG-20', transitionName: 'In Progress' });
      expect(action?.confidence).toBe('high');
    });

    it('recommends a name rather than an instance-specific id', () => {
      const [action] = forTool('mark CHG-20 as done', 'jira_transition_issue');
      expect(action?.arguments).toHaveProperty('transitionName');
      expect(action?.arguments).not.toHaveProperty('transitionId');
    });

    it('infers status from starting and finishing', () => {
      const [started] = forTool('I will start work on CHG-22 today', 'jira_transition_issue');
      expect(started?.arguments.transitionName).toBe('In Progress');

      const [finished] = forTool('We finished CHG-23', 'jira_transition_issue');
      expect(finished?.arguments.transitionName).toBe('Done');
    });

    it('drops confidence and says so for a status it cannot verify', () => {
      const [action] = forTool('move CHG-20 to pending signoff', 'jira_transition_issue');
      expect(action?.confidence).toBe('low');
      expect(action?.summary).toContain('jira_list_transitions');
      expect(action?.arguments.transitionName).toBe('pending signoff');
    });
  });

  describe('pronoun targets', () => {
    it('resolves "this" from the issue under discussion', () => {
      const [action] = forTool('assign this to dana', 'jira_update_issue', { issueKey: 'CHG-20' });
      expect(action?.arguments.issueKey).toBe('CHG-20');
      expect(action?.confidence).toBe('medium');
      expect(action?.summary).toContain('referred to as "this"');
    });

    it('reports the action without a key when there is nothing to resolve to', () => {
      const [action] = forTool('assign this to dana', 'jira_update_issue');
      expect(action?.arguments).not.toHaveProperty('issueKey');
      expect(action?.arguments.assignee).toBe('dana');
      expect(action?.confidence).toBe('low');
    });

    it('never invents a placeholder key', () => {
      const rendered = JSON.stringify(actionsOf('move it to done'));
      expect(rendered).not.toContain('SCRUM-?');
      expect(rendered).not.toContain('?-');
    });
  });

  it('collapses the same recommendation heard twice', () => {
    const actions = forTool(
      'assign CHG-20 to dana. Again: assign CHG-20 to dana.',
      'jira_update_issue'
    );
    expect(actions).toHaveLength(1);
  });

  it('orders the most confident recommendations first', () => {
    const actions = actionsOf(
      'assign this to dana. assign CHG-20 to sam. move CHG-20 to in progress.'
    );
    const confidences = actions.map((action) => action.confidence);
    expect(confidences).toEqual([...confidences].sort());
    expect(confidences[0]).toBe('high');
  });

  it('reads a whole meeting', () => {
    const transcript = [
      'Dana: welcome everyone.',
      'Sam: we need to create a bug for the checkout 500s.',
      'Dana: assign CHG-20 to sam',
      'Sam: I will start work on CHG-20 today.',
      'Dana: also move CHG-19 to done, it shipped Friday.',
      'Dana: thanks all.',
    ].join('\n');

    const actions = actionsOf(transcript, { projectKey: 'CHG' });
    expect(actions.map((action) => action.tool).sort()).toEqual([
      'jira_create_issue',
      'jira_transition_issue',
      'jira_transition_issue',
      'jira_update_issue',
    ]);
  });

  it('does not carry regex state between calls', () => {
    // The patterns are global; without a lastIndex reset the second call would
    // resume mid-string and miss the opening match.
    const first = forTool('assign CHG-20 to dana', 'jira_update_issue');
    const second = forTool('assign CHG-20 to dana', 'jira_update_issue');
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });
});

describe('meeting type', () => {
  it('reads a standup from how people talk in one', () => {
    const meeting = detectMeeting(
      'Standup: yesterday I finished CHG-20, today I will pick up CHG-21, no blockers.'
    );
    expect(meeting.type).toBe('standup');
    expect(meeting.source).toBe('inferred');
    expect(meeting.signals.length).toBeGreaterThan(0);
  });

  it('reads sprint planning from points and backlog talk', () => {
    const meeting = detectMeeting(
      'Sprint planning. CHG-20 is 5 story points, pull CHG-21 from the backlog.'
    );
    expect(meeting.type).toBe('sprint-planning');
  });

  it('reads a retro from what-went-well talk', () => {
    const meeting = detectMeeting('Retro time. The deploy went well. We should do better on QA.');
    expect(meeting.type).toBe('retro');
  });

  it('falls back to ad-hoc when nothing identifies it', () => {
    const meeting = detectMeeting('assign CHG-20 to dana');
    expect(meeting.type).toBe('ad-hoc');
    expect(meeting.signals).toEqual([]);
  });

  it('takes the caller word over its own reading', () => {
    const meeting = detectMeeting('Retro time, what went well?', { meetingType: 'standup' });
    expect(meeting).toEqual({ type: 'standup', source: 'stated', signals: [] });
  });

  it('breaks a tie on duration without overruling wording', () => {
    // Evenly weighted: "no blockers" (standup) against "do better" (retro).
    const tied = 'no blockers. we could do better.';
    expect(detectMeeting(tied, { durationMinutes: 10 }).type).toBe('standup');
    expect(detectMeeting(tied, { durationMinutes: 60 }).type).toBe('retro');

    // Unambiguous wording is not overridden by a long meeting.
    const clear = 'Standup. yesterday I shipped it. today I continue. no blockers.';
    expect(detectMeeting(clear, { durationMinutes: 90 }).type).toBe('standup');
  });

  it('weakens a reading that does not fit the meeting, without dropping it', () => {
    const line = 'create a task: rotate the keys';
    const adHoc = forTool(line, 'jira_create_issue', { projectKey: 'CHG' });
    const standup = forTool(line, 'jira_create_issue', {
      projectKey: 'CHG',
      meetingType: 'standup',
    });

    expect(adHoc[0]?.confidence).toBe('high');
    // Standups discuss issues that already exist, so this is the weaker reading
    // — but it is still reported.
    expect(standup[0]?.confidence).toBe('medium');
  });

  it('keeps sprint moves strong in planning and weak elsewhere', () => {
    const line = 'pull CHG-20 into the sprint';
    const planning = forTool(line, 'jira_move_issue_to_sprint', {
      meetingType: 'sprint-planning',
      sprintId: '42',
    });
    const standup = forTool(line, 'jira_move_issue_to_sprint', {
      meetingType: 'standup',
      sprintId: '42',
    });

    expect(planning[0]?.confidence).toBe('high');
    expect(standup[0]?.confidence).toBe('medium');
  });
});

describe('standup material', () => {
  it('turns a blocker into a comment on the issue', () => {
    const [action] = forTool('CHG-20 is blocked on the vendor patch', 'jira_add_comment');
    expect(action?.arguments.issueKey).toBe('CHG-20');
    expect(action?.arguments.comment).toContain('Blocked on the vendor patch');
    expect(action?.summary).toContain('blocked on');
  });

  it('reads a blocker phrased the other way round', () => {
    const [action] = forTool("I'm blocked on the vendor patch for CHG-20", 'jira_add_comment');
    expect(action?.arguments.issueKey).toBe('CHG-20');
  });

  it('logs time spent, normalised to what Jira accepts', () => {
    expect(forTool('I spent 2 hours on CHG-20', 'jira_log_work')[0]?.arguments).toEqual({
      issueKey: 'CHG-20',
      timeSpent: '2h',
    });
    expect(forTool('CHG-21 took me 30 minutes', 'jira_log_work')[0]?.arguments).toEqual({
      issueKey: 'CHG-21',
      timeSpent: '30m',
    });
    expect(forTool('logged 3 days on CHG-22', 'jira_log_work')[0]?.arguments.timeSpent).toBe('3d');
  });
});

describe('sprint planning material', () => {
  it('moves an issue into the sprint when the sprint is known', () => {
    const [action] = forTool('pull CHG-20 into the sprint', 'jira_move_issue_to_sprint', {
      sprintId: '42',
      meetingType: 'sprint-planning',
    });
    expect(action?.arguments).toEqual({ issueKey: 'CHG-20', sprintId: '42' });
  });

  it('says which lookup is needed when the sprint is not known', () => {
    const [action] = forTool('bring CHG-20 into the next sprint', 'jira_move_issue_to_sprint', {
      meetingType: 'sprint-planning',
    });
    expect(action?.arguments).not.toHaveProperty('sprintId');
    expect(action?.confidence).toBe('low');
    expect(action?.summary).toContain('jira_list_sprints');
  });

  it('removes an issue from the sprint', () => {
    const [action] = forTool('drop CHG-20 from the sprint', 'jira_remove_issue_from_sprint', {
      meetingType: 'sprint-planning',
    });
    expect(action?.arguments).toEqual({ issueKey: 'CHG-20' });
  });
});

describe('estimation', () => {
  it('recommends setting story points, without guessing a field id', () => {
    const [action] = forTool('CHG-20 is 5 story points', 'jira_update_issue', {
      meetingType: 'sprint-planning',
    });
    expect(action?.arguments).toEqual({ issueKey: 'CHG-20', storyPoints: 5 });
    expect(action?.summary).toContain('5 story points');
    // The per-instance id is jira_update_issue's job to resolve, not this one's.
    expect(JSON.stringify(action?.arguments)).not.toContain('customfield');
  });

  it('reads points phrased the other way round', () => {
    const [action] = forTool('8 points for CHG-21', 'jira_update_issue', {
      meetingType: 'sprint-planning',
    });
    expect(action?.arguments).toEqual({ issueKey: 'CHG-21', storyPoints: 8 });
  });

  it('takes a fractional estimate', () => {
    const [action] = forTool('CHG-22 is 0.5 points', 'jira_update_issue', {
      meetingType: 'sprint-planning',
    });
    expect(action?.arguments.storyPoints).toBe(0.5);
  });

  it('recommends an original estimate in Jira duration form', () => {
    const [action] = forTool('estimate for CHG-20 is 3 days', 'jira_update_issue', {
      meetingType: 'sprint-planning',
    });
    expect(action?.arguments).toEqual({ issueKey: 'CHG-20', originalEstimate: '3d' });
  });

  it('reads "will take" as an estimate', () => {
    const [action] = forTool('CHG-20 will take 4 hours', 'jira_update_issue', {
      meetingType: 'sprint-planning',
    });
    expect(action?.arguments.originalEstimate).toBe('4h');
  });

  it('keeps an estimate distinct from time already spent', () => {
    const estimate = forTool('CHG-20 will take 4 hours', 'jira_update_issue', {
      meetingType: 'sprint-planning',
    });
    const spent = forTool('I spent 4 hours on CHG-20', 'jira_log_work');

    expect(estimate[0]?.arguments).toHaveProperty('originalEstimate');
    expect(spent[0]?.arguments).toHaveProperty('timeSpent');
  });

  it('weakens estimation heard in a standup', () => {
    const planning = forTool('CHG-20 is 5 points', 'jira_update_issue', {
      meetingType: 'sprint-planning',
    });
    const standup = forTool('CHG-20 is 5 points', 'jira_update_issue', { meetingType: 'standup' });

    expect(planning[0]?.confidence).toBe('high');
    expect(standup[0]?.confidence).toBe('medium');
  });
});

describe('formatActionsAsMarkdown', () => {
  it('explains what it looks for when nothing matched', () => {
    const markdown = formatActionsAsMarkdown(analyzeTranscript('nothing to see here'));
    expect(markdown).toContain('No actionable items detected');
    expect(markdown).toContain('assign PROJ-12 to dana');
  });

  it('renders each action with its tool, arguments and source line', () => {
    const markdown = formatActionsAsMarkdown(analyzeTranscript('assign CHG-20 to dana.lin'));
    expect(markdown).toContain('## 1. Assign CHG-20 to dana.lin');
    expect(markdown).toContain('`jira_update_issue`');
    expect(markdown).toContain('"assignee": "dana.lin"');
    expect(markdown).toContain('**Heard as:**');
  });

  it('states plainly that nothing was executed', () => {
    const markdown = formatActionsAsMarkdown(analyzeTranscript('move CHG-20 to done'));
    expect(markdown).toContain('Nothing above has been executed');
  });

  it('names the meeting type and how it was decided', () => {
    const inferred = formatActionsAsMarkdown(
      analyzeTranscript('Standup: yesterday I finished CHG-20. no blockers.')
    );
    expect(inferred).toContain('Meeting type: **standup**');
    expect(inferred).toContain('inferred from');
    expect(inferred).toContain('meetingType');

    const stated = formatActionsAsMarkdown(
      analyzeTranscript('move CHG-20 to done', { meetingType: 'retro' })
    );
    expect(stated).toContain('Meeting type: **retrospective** (as given)');
    expect(stated).not.toContain('inferred from');
  });

  it('renders an estimate as a callable update', () => {
    const markdown = formatActionsAsMarkdown(analyzeTranscript('CHG-20 is 5 story points'));
    expect(markdown).toContain('`jira_update_issue`');
    expect(markdown).toContain('"storyPoints": 5');
  });
});

describe('isMeetingType', () => {
  it('accepts the four types and rejects anything else', () => {
    expect(isMeetingType('standup')).toBe(true);
    expect(isMeetingType('sprint-planning')).toBe(true);
    expect(isMeetingType('retro')).toBe(true);
    expect(isMeetingType('ad-hoc')).toBe(true);
    expect(isMeetingType('all-hands')).toBe(false);
    expect(isMeetingType(undefined)).toBe(false);
  });
});
