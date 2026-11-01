/**
 * The thread's send path (chat-thread.model.ts), as a person chatting would
 * describe it: what a Send asks for, the queue behind a running reply,
 * editing and resending an earlier prompt, and the rename / delete dialogs.
 * chat-compaction.spec.ts keeps one real queue drained by the model,
 * surviving a reload; chat-time-zone.spec.ts keeps the browser's time zone
 * reaching the turns route.
 */

import type { AttachmentView, ChatMessageView, QueuedSend } from '@/lib/chat/views';
import {
  connectorsPatch,
  initialModelId,
  initialThreadSend,
  isCompactCommand,
  lastQueueId,
  nextToSend,
  promptActionsOffered,
  promptTextOf,
  queueView,
  renameRequest,
  resendRequest,
  resentPrompt,
  submitRoute,
  threadSendReducer,
  turnRequest,
  type ThreadSendAction,
  type ThreadSendState,
} from './chat-thread.model';

const file = (id: string): AttachmentView => ({
  id,
  filename: `${id}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 1,
  extractStatus: 'done',
});

const prompt = (text: string, attachments: AttachmentView[] = []): ChatMessageView => ({
  id: 'm1',
  turnId: 't1',
  seq: 3,
  role: 'user',
  kind: 'prompt',
  status: 'complete',
  blocks: [{ type: 'text', text }],
  llmModelId: null,
  provider: null,
  model: null,
  stopReason: null,
  usage: null,
  error: null,
  createdAt: '2026-11-01T09:00:00.000Z',
  attachments,
});

const empty = initialThreadSend({ queue: [] });
const run = (actions: ThreadSendAction[], from: ThreadSendState = empty) =>
  actions.reduce(threadSendReducer, from);

const message = (text: string, attachments: AttachmentView[] = []) => ({ text, attachments });

describe('what a Send asks for', () => {
  it('the text, the files by id and the chat’s model', () => {
    expect(turnRequest(message('Hi', [file('a'), file('b')]), 'model-1')).toEqual({
      text: 'Hi',
      attachmentIds: ['a', 'b'],
      llmModelId: 'model-1',
    });
  });

  it('a spoken message says so, so the reply is written to be heard', () => {
    expect(turnRequest({ ...message('Hi'), voice: true }, null)).toMatchObject({ voice: true });
  });

  it('/compact runs a compaction pass rather than going to the model as words', () => {
    expect(isCompactCommand(' /Compact ')).toBe(true);
    expect(isCompactCommand('/compact this please')).toBe(false);
  });

  it('a chat opens on its own model, else the default, else the first, else none', () => {
    const models = [
      { id: 'a', isDefault: false },
      { id: 'b', isDefault: true },
    ];
    expect(initialModelId({ llmModelId: 'z' }, models)).toBe('z');
    expect(initialModelId({ llmModelId: null }, models)).toBe('b');
    expect(initialModelId({ llmModelId: null }, [{ id: 'a', isDefault: false }])).toBe('a');
    expect(initialModelId({ llmModelId: null }, [])).toBeNull();
  });

  it('choosing connectors saves the list; going back to the defaults saves none', () => {
    expect(connectorsPatch(['jira'])).toEqual({ toolConfig: { connectors: ['jira'] } });
    expect(connectorsPatch(null)).toEqual({ toolConfig: null });
  });
});

describe('the queue behind a running reply', () => {
  it('a Send while a reply runs is queued, not rejected; with nothing running it goes', () => {
    expect(submitRoute(empty, true)).toBe('queue');
    expect(submitRoute(empty, false)).toBe('send');
  });

  it('lists each queued send in order, by what it will do', () => {
    const queued = run([
      { type: 'messageQueued', id: 1, input: message('  Left this for later  ') },
      { type: 'compactQueued', id: 2 },
      { type: 'messageQueued', id: 3, input: message('', [file('a'), file('b')]) },
      { type: 'messageQueued', id: 4, input: message('', [file('c')]) },
      { type: 'messageQueued', id: 5, input: message('  ') },
    ]);
    expect(queueView(queued.queue)).toEqual([
      { id: 1, isCompact: false, label: 'Left this for later' },
      { id: 2, isCompact: true, label: 'Compact this conversation' },
      { id: 3, isCompact: false, label: '2 files' },
      { id: 4, isCompact: false, label: '1 file' },
      { id: 5, isCompact: false, label: 'Message' },
    ]);
  });

  it('one can be removed and the rest keep their order; Clear all removes every one', () => {
    const queued = run([
      { type: 'messageQueued', id: 1, input: message('first') },
      { type: 'compactQueued', id: 2 },
      { type: 'messageQueued', id: 3, input: message('third') },
    ]);
    expect(run([{ type: 'queuedRemoved', id: 1 }], queued).queue.map((q) => q.id)).toEqual([2, 3]);
    expect(run([{ type: 'queueCleared' }], queued).queue).toEqual([]);
  });

  it('drains oldest first, one at a time, only once the model is free', () => {
    const queued = run([
      { type: 'messageQueued', id: 1, input: message('first') },
      { type: 'compactQueued', id: 2 },
    ]);
    expect(nextToSend(queued.queue, { running: true, readingReply: false })).toBeNull();
    expect(nextToSend(queued.queue, { running: false, readingReply: false })?.id).toBe(1);
    const after = run([{ type: 'queuedSent', id: 1 }], queued);
    expect(nextToSend(after.queue, { running: false, readingReply: false })?.kind).toBe('compact');
    expect(nextToSend([], { running: false, readingReply: false })).toBeNull();
  });

  it('waits while the reply is still being read aloud', () => {
    const queued = run([{ type: 'messageQueued', id: 1, input: message('later') }]);
    expect(nextToSend(queued.queue, { running: false, readingReply: true })).toBeNull();
  });

  it('a queued spoken message heard again in another language changes only its words', () => {
    const queued = run([
      { type: 'messageQueued', id: 1, input: { ...message('hola'), voice: true } },
      { type: 'compactQueued', id: 2 },
    ]);
    const corrected = run(
      [
        { type: 'queuedTextCorrected', id: 1, text: 'hello' },
        { type: 'queuedTextCorrected', id: 2, text: 'ignored' },
      ],
      queued
    );
    expect(corrected.queue).toEqual([
      { id: 1, kind: 'message', input: { text: 'hello', attachments: [], voice: true } },
      { id: 2, kind: 'compact' },
    ]);
  });

  it('a reloaded page keeps what was waiting and draws new ids after it', () => {
    const held: QueuedSend[] = [
      { id: 4, kind: 'compact' },
      { id: 9, kind: 'message', input: message('x') },
    ];
    expect(initialThreadSend({ queue: held }).queue).toEqual(held);
    expect(lastQueueId(held)).toBe(9);
    expect(lastQueueId([])).toBe(0);
  });
});

describe('editing and resending an earlier prompt', () => {
  it('only the owner may, and only with nothing running or sending', () => {
    expect(promptActionsOffered({ isOwner: true, running: false, sending: false })).toBe(true);
    expect(promptActionsOffered({ isOwner: false, running: false, sending: false })).toBe(false);
    expect(promptActionsOffered({ isOwner: true, running: true, sending: false })).toBe(false);
    expect(promptActionsOffered({ isOwner: true, running: false, sending: true })).toBe(false);
  });

  it('the box gets the prompt’s typed text, without the attachment excerpts the model saw', () => {
    const row = prompt('Summarise this\n<attachment name="a.pdf">lots of text</attachment>');
    expect(promptTextOf(row)).toBe('Summarise this');
  });

  it('while editing, Send resends that prompt — even with a reply running', () => {
    const editing = run([{ type: 'editStarted', message: prompt('Old') }]);
    expect(submitRoute(editing, false)).toBe('resend');
    expect(submitRoute(editing, true)).toBe('resend');
    expect(run([{ type: 'editCancelled' }], editing).editing).toBeNull();
  });

  it('an edited resend sends the new text and new files; the row keeps the old files too', () => {
    const row = prompt('Old', [file('old')]);
    const input = message('New', [file('new')]);
    expect(resendRequest(input, 'model-1')).toEqual({
      text: 'New',
      attachmentIds: ['new'],
      llmModelId: 'model-1',
    });
    expect(resentPrompt(row, input)).toEqual({
      text: 'New',
      attachments: [file('old'), file('new')],
    });
  });

  it('“Resend” as it was sends no text, and the row shows the old prompt', () => {
    const row = prompt('As it was', [file('old')]);
    expect(resendRequest(null, null)).toEqual({ text: null, attachmentIds: [], llmModelId: null });
    expect(resentPrompt(row, null)).toEqual({ text: 'As it was', attachments: [file('old')] });
  });

  it('a resend asks first; cancelling keeps everything; a started resend ends the edit', () => {
    const asked = run([{ type: 'resendAsked', message: prompt('Again') }]);
    expect(asked.confirmResend?.id).toBe('m1');
    expect(run([{ type: 'resendDismissed' }], asked).confirmResend).toBeNull();
    const editing = run([{ type: 'editStarted', message: prompt('Old') }, { type: 'resent' }]);
    expect(editing.editing).toBeNull();
  });
});

describe('rename and delete', () => {
  it('Rename opens on the current title with no old error', () => {
    const failed = run([
      { type: 'renameOpened', title: 'A' },
      { type: 'manageFailed', error: 'No.' },
    ]);
    const reopened = run(
      [{ type: 'dialogClosed' }, { type: 'renameOpened', title: 'Q3 plan' }],
      failed
    );
    expect(reopened).toMatchObject({ dialog: 'rename', renameDraft: 'Q3 plan', manageError: null });
    expect(run([{ type: 'renameOpened', title: null }]).renameDraft).toBe('');
  });

  it('an empty name is refused; a name is saved trimmed', () => {
    expect(renameRequest('   ')).toEqual({ error: 'The name can’t be empty.' });
    expect(renameRequest('  Q3 plan ')).toEqual({ title: 'Q3 plan' });
  });

  it('a refused rename or delete keeps the dialog open with the reason; success closes it', () => {
    const busy = run([{ type: 'deleteOpened' }, { type: 'manageStarted' }]);
    expect(busy.manageBusy).toBe(true);
    const refused = run([{ type: 'manageFailed', error: 'Not yours.' }], busy);
    expect(refused).toMatchObject({
      dialog: 'delete',
      manageBusy: false,
      manageError: 'Not yours.',
    });
    const retried = run([{ type: 'manageStarted' }], refused);
    expect(retried.manageError).toBeNull();
    expect(run([{ type: 'manageDone' }], retried)).toMatchObject({
      dialog: null,
      manageBusy: false,
    });
  });

  it('Switch branch opens its picker', () => {
    expect(run([{ type: 'branchOpened' }]).dialog).toBe('branch');
  });
});
