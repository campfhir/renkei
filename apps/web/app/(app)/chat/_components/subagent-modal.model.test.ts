/**
 * The sub-agent modal's behaviour, as a person meets it: the run read and
 * followed while it works, and Stop on one still working.
 */

import type { SubagentRunView } from '@/lib/chat/subagent-runs';
import {
  canStop,
  initialSubagentModal,
  keepsAsking,
  showsStop,
  statusWord,
  stopLabel,
  subagentModalReducer,
  type SubagentModalAction,
} from './subagent-modal.model';

const run = (status: SubagentRunView['status']): SubagentRunView => ({
  id: 'r1',
  toolUseId: 'tu1',
  turnId: 't1',
  status,
  task: 'Build the parser',
  instructions: null,
  readOnly: false,
  model: null,
  steps: 2,
  maxSteps: 40,
  toolCalls: 3,
  lastTool: 'code_read_file',
  transcript: [],
  report: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 5 },
  startedAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:05.000Z',
  finishedAt: null,
});

const after = (...actions: SubagentModalAction[]) =>
  actions.reduce(subagentModalReducer, initialSubagentModal);

describe('the sub-agent modal', () => {
  it('follows a run that is still working and stops asking once it has ended', () => {
    expect(keepsAsking(after({ type: 'loaded', run: run('running') }))).toBe(true);
    expect(keepsAsking(after({ type: 'loaded', run: run('completed') }))).toBe(false);
  });

  it('waits for a sub-agent whose call has not started, and says when a run was never recorded', () => {
    const waiting = after({
      type: 'loadFailed',
      message: 'No such sub-agent run',
      notStarted: true,
    });
    expect(waiting.queued).toBe(true);
    expect(waiting.error).toBeNull();
    expect(keepsAsking(waiting)).toBe(true);

    const gone = after({ type: 'loadFailed', message: 'No such sub-agent run', notStarted: false });
    expect(gone.error).toMatch(/was not recorded/);
    expect(keepsAsking(gone)).toBe(false);
    expect(after({ type: 'loadFailed', message: null, notStarted: false }).error).toBe(
      'The sub-agent’s run could not be read.'
    );
  });

  it('offers Stop to the owner while the sub-agent works, and to nobody once it has ended', () => {
    const working = after({ type: 'loaded', run: run('running') });
    expect(showsStop(working, true)).toBe(true);
    expect(canStop(working, true)).toBe(true);
    expect(stopLabel(working)).toBe('Stop sub-agent');
    // Someone the chat is shared with reads the run; they stop nothing.
    expect(showsStop(working, false)).toBe(false);
    for (const status of ['completed', 'failed', 'interrupted'] as const) {
      expect(showsStop(after({ type: 'loaded', run: run(status) }), true)).toBe(false);
    }
    expect(showsStop(initialSubagentModal, true)).toBe(false);
  });

  it('a pressed Stop waits: it cannot be pressed twice, and the run is followed until it ends', () => {
    const pressed = after({ type: 'loaded', run: run('running') }, { type: 'stopPressed' });
    expect(pressed.stop).toBe('stopping');
    expect(canStop(pressed, true)).toBe(false);
    expect(stopLabel(pressed)).toBe('Stopping…');
    expect(subagentModalReducer(pressed, { type: 'stopPressed' })).toBe(pressed);

    // Asked: the sub-agent stops at its next step, so it still reads working.
    const asked = subagentModalReducer(pressed, { type: 'stopAsked' });
    expect(asked.stop).toBe('asked');
    expect(showsStop(asked, true)).toBe(true);
    expect(canStop(asked, true)).toBe(false);
    expect(keepsAsking(asked)).toBe(true);

    const ended = subagentModalReducer(asked, { type: 'loaded', run: run('interrupted') });
    expect(ended.stop).toBe('idle');
    expect(showsStop(ended, true)).toBe(false);
    expect(statusWord(ended.run!)).toBe('stopped');
  });

  it('a refused Stop keeps the run on screen, says why, and can be pressed again', () => {
    const refused = after(
      { type: 'loaded', run: run('running') },
      { type: 'stopPressed' },
      { type: 'stopRefused', message: 'No such chat' }
    );
    expect(refused.run?.status).toBe('running');
    expect(refused.stopError).toBe('No such chat');
    expect(canStop(refused, true)).toBe(true);
    expect(after({ type: 'stopPressed' }).stop).toBe('idle');
  });
});
