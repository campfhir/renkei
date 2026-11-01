/**
 * The chat composer's behaviour (composer.model.ts), as a person writing a
 * message would describe it: staging files (chips or one counter, the
 * mass-upload warning, the project question, OCR), the button in the send
 * slot (Stop vs Queue vs Send), what Send does with files still being
 * placed, the queue row, and dictation into the box. The browser specs
 * (mass-upload, chat-compaction, composer-tools-menu) keep the screenshots,
 * the phone-width fit and one real upload and queue each.
 */

import type { AttachmentView } from '@/lib/chat/views';
import {
  FOLD_AT,
  OCR_BATCH,
  appendSpoken,
  batchWarning,
  composerReducer,
  dropQuestion,
  extractStatusLabel,
  filesChosen,
  hasDraft,
  initialComposer,
  insertPrompt,
  needsOcr,
  ocrBatches,
  placeholder,
  proceedWith,
  queueRow,
  readyToSendAfterUpload,
  rememberedLabel,
  sendButton,
  sendStep,
  sizeOf,
  stagingRow,
  type ComposerAction,
  type ComposerState,
  type NamedFile,
} from './composer.model';

const THRESHOLD = 10;

const file = (name: string): NamedFile => ({ name });
const files = (count: number, prefix = 'applicant') =>
  Array.from({ length: count }, (_, index) => file(`${prefix}-${index + 1}.pdf`));
const attachment = (id: string, more: Partial<AttachmentView> = {}): AttachmentView => ({
  id,
  filename: `${id}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 100,
  extractStatus: 'done',
  ...more,
});

const run = (actions: ComposerAction[], from: ComposerState = initialComposer(undefined)) =>
  actions.reduce(composerReducer, from);

/** Choose files outside a project and fold in whatever that leads to. */
function choose(state: ComposerState, chosen: NamedFile[]): ComposerState {
  const action = filesChosen(state, chosen, {
    inProject: false,
    remembered: null,
    threshold: THRESHOLD,
  });
  return action ? composerReducer(state, action) : state;
}

/** Every file of an upload under way answered, successfully. */
function uploaded(state: ComposerState, ids: string[]): ComposerState {
  return run(
    [
      ...ids.map((id): ComposerAction => ({ type: 'fileUploaded', attachment: attachment(id) })),
      { type: 'uploadSettled', count: ids.length },
    ],
    state
  );
}

describe('the box', () => {
  it('starts with the saved draft, or empty', () => {
    expect(initialComposer('Half a thought').text).toBe('Half a thought');
    expect(initialComposer(undefined).text).toBe('');
  });

  it('editing an earlier message fills the box with it; cancelling empties it', () => {
    const editing = run([{ type: 'editStarted', text: 'What I asked before' }]);
    expect(editing.text).toBe('What I asked before');
    expect(run([{ type: 'editCancelled' }], editing).text).toBe('');
  });

  it('a prompt from the library goes on its own line below what is typed', () => {
    expect(insertPrompt('', 'Summarise this.')).toBe('Summarise this.');
    expect(insertPrompt('Hello', 'Summarise this.')).toBe('Hello\nSummarise this.');
    const picked = run([
      { type: 'typed', text: 'Hello' },
      { type: 'promptsOpened' },
      { type: 'promptPicked', body: 'Summarise this.' },
    ]);
    expect(picked.text).toBe('Hello\nSummarise this.');
    expect(picked.prompts).toBe(false);
  });

  it('a successful send empties the box and drops the staged files', () => {
    const sent = run([
      { type: 'typed', text: 'Look at these' },
      { type: 'uploadStarted', files: files(1), keep: false },
      { type: 'fileUploaded', attachment: attachment('a') },
      { type: 'submitted' },
    ]);
    expect(sent.text).toBe('');
    expect(sent.attachments).toEqual([]);
  });
});

describe('staging files', () => {
  it('two files stay as chips; the third folds them into one counter chip', () => {
    const two = uploaded(choose(initialComposer(undefined), files(2)), ['a', 'b']);
    expect(stagingRow(two)).toMatchObject({ shown: true, folded: false });
    const three = uploaded(choose(two, [file('third.pdf')]), ['c']);
    expect(FOLD_AT).toBe(3);
    expect(stagingRow(three)).toMatchObject({ folded: true, counter: '3 attachments' });
  });

  it('nothing staged shows no row at all', () => {
    expect(stagingRow(initialComposer(undefined)).shown).toBe(false);
  });

  it('shows how far an upload has got', () => {
    const going = run([
      { type: 'uploadStarted', files: files(14), keep: false },
      { type: 'fileUploaded', attachment: attachment('a') },
      { type: 'fileUploaded', attachment: attachment('b') },
    ]);
    expect(stagingRow(going).uploading).toBe('Uploading 2/14…');
    expect(stagingRow(going).shown).toBe(true);
  });

  it('a failed file says which one and why, and the rest carry on', () => {
    const failed = run([
      { type: 'uploadStarted', files: files(2), keep: false },
      { type: 'fileFailed', filename: 'applicant-1.pdf', error: 'Too large.' },
      { type: 'fileUploaded', attachment: attachment('b') },
      { type: 'uploadSettled', count: 2 },
    ]);
    expect(failed.uploadError).toBe('applicant-1.pdf: Too large.');
    expect(failed.attachments.map((a) => a.id)).toEqual(['b']);
    expect(stagingRow(failed).uploading).toBeNull();
    const unknown = run([
      { type: 'uploadStarted', files: files(1), keep: false },
      { type: 'fileFailed', filename: 'x.pdf', error: null },
    ]);
    expect(unknown.uploadError).toBe('x.pdf: upload failed');
  });

  it('a new upload clears the last error', () => {
    const failed = run([
      { type: 'uploadStarted', files: files(1), keep: false },
      { type: 'fileFailed', filename: 'x.pdf', error: 'No.' },
    ]);
    expect(choose(failed, files(1)).uploadError).toBeNull();
  });

  it('removing a file takes it off the message; removing the last closes the list', () => {
    const three = uploaded(choose(initialComposer(undefined), files(3)), ['a', 'b', 'c']);
    const open = run([{ type: 'listOpened' }], three);
    expect(open.listOpen).toBe(true);
    const fewer = run([{ type: 'attachmentRemoved', id: 'c' }], open);
    expect(fewer.attachments.map((a) => a.id)).toEqual(['a', 'b']);
    expect(fewer.listOpen).toBe(true);
    const none = run(
      [
        { type: 'attachmentRemoved', id: 'a' },
        { type: 'attachmentRemoved', id: 'b' },
      ],
      fewer
    );
    expect(none.listOpen).toBe(false);
  });
});

describe('a mass upload', () => {
  it('at the threshold nothing asks: the files upload at once', () => {
    const action = filesChosen(initialComposer(undefined), files(THRESHOLD), {
      inProject: false,
      remembered: null,
      threshold: THRESHOLD,
    });
    expect(action?.type).toBe('uploadStarted');
  });

  it('over the threshold asks first, counting what is staged and uploading too', () => {
    expect(choose(initialComposer(undefined), files(14)).pendingBatch).toHaveLength(14);
    const staged = uploaded(choose(initialComposer(undefined), files(9)), [...'abcdefghi']);
    expect(proceedWith(staged, files(1), false, THRESHOLD).type).toBe('uploadStarted');
    expect(proceedWith(staged, files(2), false, THRESHOLD).type).toBe('batchHeld');
    const inFlight = run([{ type: 'uploadStarted', files: files(9), keep: false }]);
    expect(proceedWith(inFlight, files(2), false, THRESHOLD).type).toBe('batchHeld');
  });

  it('the warning names how many files and what a mass upload means', () => {
    const words = batchWarning(files(14), THRESHOLD);
    expect(words.title).toBe('Add 14 files? Large uploads take a while.');
    expect(words.detail).toContain('More than 10 files is a mass upload');
    expect(words.confirm).toBe('Upload 14 files');
    expect(batchWarning(files(1), 0).title).toBe('Add 1 file? Large uploads take a while.');
  });

  it('cancelling the warning uploads nothing', () => {
    const cancelled = run(
      [{ type: 'batchCancelled' }],
      choose(initialComposer(undefined), files(14))
    );
    expect(cancelled.pendingBatch).toBeNull();
    expect(cancelled.uploading).toBe(0);
    expect(cancelled.attachments).toEqual([]);
  });

  it('confirming uploads every held file, kept where the files were going', () => {
    const held = run([{ type: 'batchHeld', files: files(14), keep: true }]);
    const confirmed = run([{ type: 'batchConfirmed' }], held);
    expect(confirmed.pendingBatch).toBeNull();
    expect(confirmed.uploading).toBe(14);
    expect(confirmed.uploadTotal).toBe(14);
    expect(confirmed.keepChoice).toBe(true);
  });

  it('files chosen while the warning is up join the held batch when they too cross the line', () => {
    const held = choose(initialComposer(undefined), files(14));
    const more = choose(held, files(11, 'more'));
    expect(more.pendingBatch).toHaveLength(25);
  });

  it('scanned files are read with OCR after they upload, at most twelve per request', () => {
    const stored = [
      attachment('a', { extractStatus: 'needs_ocr' }),
      attachment('b'),
      attachment('c', { extractStatus: 'needs_ocr' }),
    ];
    expect(needsOcr(stored)).toEqual(['a', 'c']);
    const ids = Array.from({ length: 30 }, (_, index) => `s${index}`);
    expect(ocrBatches(ids).map((batch) => batch.length)).toEqual([OCR_BATCH, OCR_BATCH, 6]);
    expect(ocrBatches(ids).flat()).toEqual(ids);
  });

  it('shows how many scans are left, and each file’s text status once read', () => {
    const staged = run([
      { type: 'uploadStarted', files: files(2), keep: false },
      { type: 'fileUploaded', attachment: attachment('a', { extractStatus: 'needs_ocr' }) },
      { type: 'fileUploaded', attachment: attachment('b', { extractStatus: 'needs_ocr' }) },
      { type: 'uploadSettled', count: 2 },
      { type: 'ocrStarted', count: 2 },
    ]);
    expect(stagingRow(staged).ocr).toBe('Reading scans (2 left)…');
    expect(extractStatusLabel(staged.attachments[0].extractStatus)).toBe('Waiting for OCR');
    const read = run(
      [
        {
          type: 'ocrAnswered',
          count: 2,
          results: [
            { id: 'a', extractStatus: 'done' },
            { id: 'b', extractStatus: 'ocr_failed' },
          ],
        },
      ],
      staged
    );
    expect(stagingRow(read).ocr).toBeNull();
    expect(read.attachments.map((a) => extractStatusLabel(a.extractStatus))).toEqual([
      null,
      'OCR failed',
    ]);
    expect(extractStatusLabel('empty')).toBe('No text');
  });
});

describe('in a project: where dropped files go', () => {
  const inProject = (remembered: 'project' | 'message' | null) => ({
    inProject: true,
    remembered,
    threshold: THRESHOLD,
  });

  it('asks the first time, starting on "keep it in the project"', () => {
    const chosen = files(2);
    const action = filesChosen(initialComposer(undefined), chosen, inProject(null));
    expect(action).toEqual({ type: 'destinationAsked', files: chosen });
    const asked = run([{ type: 'dropChoiceChanged', choice: 'message' }, action!]);
    expect(asked.dropChoice).toBe('project');
    expect(dropQuestion(asked.pendingDrop!)).toBe('Where should these 2 files go?');
    expect(dropQuestion([file('cv.pdf')])).toBe('Where should cv.pdf go?');
  });

  it('a remembered answer is used without asking', () => {
    const kept = filesChosen(initialComposer(undefined), files(1), inProject('project'));
    expect(kept).toMatchObject({ type: 'uploadStarted', keep: true });
    const message = filesChosen(initialComposer(undefined), files(1), inProject('message'));
    expect(message).toMatchObject({ type: 'uploadStarted', keep: false });
  });

  it('outside a project files are never kept', () => {
    const action = filesChosen(initialComposer(undefined), files(1), {
      inProject: false,
      remembered: 'project',
      threshold: THRESHOLD,
    });
    expect(action).toMatchObject({ type: 'uploadStarted', keep: false });
  });

  it('Add remembers the answer when asked to, and shows it so it can be changed', () => {
    const asked = run([{ type: 'destinationAsked', files: files(1) }]);
    const remembered = run([{ type: 'dropConfirmed', inProject: true }], asked);
    expect(remembered.pendingDrop).toBeNull();
    expect(remembered.remembered).toBe('project');
    expect(rememberedLabel('project', 'Hiring')).toEqual({
      short: 'Files → artifacts',
      where: 'Hiring’s artifacts',
    });
    expect(rememberedLabel('message', 'Hiring').where).toBe('this message only');

    const once = run(
      [
        { type: 'rememberDropChanged', on: false },
        { type: 'dropChoiceChanged', choice: 'message' },
        { type: 'dropConfirmed', inProject: true },
      ],
      asked
    );
    expect(once.remembered).toBeNull();
    expect(run([{ type: 'dropForgotten' }], remembered).remembered).toBeNull();
  });

  it('cancelling the question drops the files and any send waiting on them', () => {
    const waiting = run([
      { type: 'typed', text: 'Here' },
      { type: 'destinationAsked', files: files(1) },
      { type: 'sendQueuedBehindUploads' },
      { type: 'dropCancelled' },
    ]);
    expect(waiting.pendingDrop).toBeNull();
    expect(waiting.sendWhenUploaded).toBe(false);
    expect(waiting.text).toBe('Here');
  });
});

describe('Send', () => {
  it('sends the trimmed text and the staged files', () => {
    const state = run([
      { type: 'typed', text: '  Read this  ' },
      { type: 'uploadStarted', files: files(1), keep: false },
      { type: 'fileUploaded', attachment: attachment('a') },
      { type: 'uploadSettled', count: 1 },
    ]);
    expect(sendStep(state, false)).toEqual({
      kind: 'submit',
      input: { text: 'Read this', attachments: [attachment('a')] },
    });
  });

  it('does nothing with an empty box, while disabled, or while a file uploads', () => {
    expect(sendStep(run([{ type: 'typed', text: '   ' }]), false).kind).toBe('nothing');
    expect(sendStep(run([{ type: 'typed', text: 'Hi' }]), true).kind).toBe('nothing');
    const uploading = run([
      { type: 'typed', text: 'Hi' },
      { type: 'uploadStarted', files: files(1), keep: false },
    ]);
    expect(sendStep(uploading, false).kind).toBe('nothing');
  });

  it('files alone are something to send', () => {
    const state = run([
      { type: 'uploadStarted', files: files(1), keep: false },
      { type: 'fileUploaded', attachment: attachment('a') },
    ]);
    expect(sendStep(state, false)).toMatchObject({ kind: 'submit', input: { text: '' } });
  });

  it('with the project question open, Send answers it and goes once the files are up', () => {
    const asked = run([
      { type: 'typed', text: 'Have a look' },
      { type: 'destinationAsked', files: files(2) },
    ]);
    expect(hasDraft(asked)).toBe(true);
    expect(sendStep(asked, false).kind).toBe('placeThenSend');
    const answered = run(
      [
        { type: 'sendQueuedBehindUploads' },
        { type: 'dropConfirmed', inProject: true },
        { type: 'uploadStarted', files: files(2), keep: true },
      ],
      asked
    );
    expect(readyToSendAfterUpload(answered)).toBe(false);
    const up = uploaded(answered, ['a', 'b']);
    expect(readyToSendAfterUpload(up)).toBe(true);
    expect(sendStep(up, false)).toMatchObject({ kind: 'submit', input: { text: 'Have a look' } });
    expect(readyToSendAfterUpload(run([{ type: 'sendAfterUploadTaken' }], up))).toBe(false);
  });

  it('a send waiting on files also waits on the mass-upload warning, and its Cancel drops it', () => {
    const held = run([
      { type: 'typed', text: 'All of them' },
      { type: 'sendQueuedBehindUploads' },
      { type: 'batchHeld', files: files(14), keep: false },
    ]);
    expect(readyToSendAfterUpload(held)).toBe(false);
    const cancelled = run([{ type: 'batchCancelled' }], held);
    expect(cancelled.sendWhenUploaded).toBe(false);
    expect(readyToSendAfterUpload(cancelled)).toBe(false);
    expect(cancelled.text).toBe('All of them');
  });
});

describe('the send slot', () => {
  const idle = initialComposer(undefined);
  const typed = run([{ type: 'typed', text: 'Next question' }]);

  it('while a reply runs and the box is empty, it is Stop', () => {
    expect(sendButton(idle, { running: true, disabled: false })).toEqual({ kind: 'stop' });
  });

  it('typing while a reply runs swaps Stop for the blue queue button; emptying brings Stop back', () => {
    expect(sendButton(typed, { running: true, disabled: false })).toEqual({
      kind: 'queue',
      disabled: false,
    });
    const emptied = run([{ type: 'typed', text: '' }], typed);
    expect(sendButton(emptied, { running: true, disabled: false }).kind).toBe('stop');
  });

  it('queueing waits for uploads to finish', () => {
    const uploading = run([{ type: 'uploadStarted', files: files(1), keep: false }], typed);
    expect(sendButton(uploading, { running: true, disabled: false })).toEqual({
      kind: 'queue',
      disabled: true,
    });
  });

  it('with nothing running it is Send, on only when there is something to send', () => {
    expect(sendButton(idle, { running: false, disabled: false })).toEqual({
      kind: 'send',
      disabled: true,
    });
    expect(sendButton(typed, { running: false, disabled: false })).toEqual({
      kind: 'send',
      disabled: false,
    });
    expect(sendButton(typed, { running: false, disabled: true })).toEqual({
      kind: 'send',
      disabled: true,
    });
  });
});

describe('the queue row', () => {
  it('one queued send shows inline; more collapse to a summary that opens the list', () => {
    expect(queueRow(0)).toBe('none');
    expect(queueRow(1)).toBe('inline');
    expect(queueRow(2)).toBe('summary');
  });

  it('the list closes itself once one item or none is left, and stays closed', () => {
    const open = run([{ type: 'queueOpened' }, { type: 'queueLengthChanged', length: 3 }]);
    expect(open.queueOpen).toBe(true);
    const down = run([{ type: 'queueLengthChanged', length: 1 }], open);
    expect(down.queueOpen).toBe(false);
    expect(run([{ type: 'queueLengthChanged', length: 2 }], down).queueOpen).toBe(false);
  });
});

describe('dictation', () => {
  it('the box says what is happening', () => {
    const idle = initialComposer(undefined);
    expect(placeholder(idle, false)).toBe('Message Renkei');
    expect(placeholder(idle, true)).toBe('Replying… Enter queues the next message');
    const on = run([{ type: 'dictationStarted' }]);
    expect(placeholder(on, true)).toMatch(/^Speak, then pause/);
    expect(placeholder(run([{ type: 'speechHeard' }], on), false)).toBe('Listening…');
    expect(placeholder(run([{ type: 'dictationStopped' }], on), false)).toBe('Message Renkei');
  });

  it('what is said is appended to what is typed, one space between', () => {
    expect(appendSpoken('', 'hello')).toBe('hello');
    expect(appendSpoken('   ', 'hello')).toBe('hello');
    expect(appendSpoken('Dear team,  \n', 'thanks')).toBe('Dear team, thanks');
    const state = run([
      { type: 'typed', text: 'Dear team,' },
      { type: 'spoken', text: '  thanks  ' },
      { type: 'spoken', text: '   ' },
    ]);
    expect(state.text).toBe('Dear team, thanks');
  });

  it('a failed transcription says why and keeps listening; a microphone error stops it', () => {
    const on = run([{ type: 'dictationStarted' }]);
    const missed = run([{ type: 'transcriptionFailed', error: 'Not heard.' }], on);
    expect(missed).toMatchObject({ dictating: true, dictationError: 'Not heard.' });
    const broken = run([{ type: 'dictationFailed', error: 'No microphone.' }], on);
    expect(broken).toMatchObject({ dictating: false, dictationError: 'No microphone.' });
    expect(run([{ type: 'dictationStarted' }], broken).dictationError).toBeNull();
  });
});

describe('file sizes', () => {
  it('reads in bytes, kilobytes or megabytes', () => {
    expect(sizeOf(512)).toBe('512 B');
    expect(sizeOf(2048)).toBe('2 KB');
    expect(sizeOf(5 * 1024 * 1024 + 100_000)).toBe('5.1 MB');
  });
});
