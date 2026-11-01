/**
 * The chat composer's state (composer.tsx): the text in the box, the files
 * staged for the message (uploading, uploaded, being OCR'd), the two
 * questions a choice of files can raise — where they go, in a project, and
 * whether a mass upload is wanted — the dictation microphone, and the
 * small dialogs it opens (the prompt picker, the attachment list, the
 * queue).
 *
 * The component makes the calls (uploads, OCR, deletes, transcription,
 * the browser's remembered drop choice) and dispatches what the person did
 * and what came back; what the composer decides from that — where a choice
 * of files goes, whether chips fold into a counter, what the button in the
 * send slot is and whether it is on, what Send does with files still being
 * placed, what the box says while idle, running or dictating — is here,
 * and tested in composer.model.test.ts.
 */

import type { AttachmentView } from '@/lib/chat/views';

/** What the composer hands its caller on Send. */
export interface ComposerSubmit {
  text: string;
  attachments: AttachmentView[];
  /** Said, not typed: from a voice conversation, so the reply is written to be heard. */
  voice?: boolean;
}

/** One queued send, shown in order with what it will do and how to drop it. */
export interface QueuedComposerItem {
  id: number;
  label: string;
  isCompact: boolean;
}

/** From this many files on, the chips collapse into one counter chip that opens the full list. */
export const FOLD_AT = 3;
/** Files sent to the server at once in a mass upload. */
export const UPLOAD_CONCURRENCY = 4;
/** Files OCR'd per request; the server takes at most this many. */
export const OCR_BATCH = 12;

/** In a project, where a dropped file goes: kept as a project artifact, or this message only. */
export type DropDestination = 'project' | 'message';

/** The least a staged file needs for the composer to talk about it. */
export interface NamedFile {
  name: string;
}

export interface ComposerState<F extends NamedFile = NamedFile> {
  text: string;
  /** Uploaded and staged for the next Send. */
  attachments: AttachmentView[];
  /** Files sent to the server and not answered yet. */
  uploading: number;
  /** Files in the uploads under way, answered or not: the denominator of "Uploading 3/14". */
  uploadTotal: number;
  /** Files whose OCR has not come back yet. */
  ocrPending: number;
  uploadError: string | null;
  /** A mass upload waiting on the person's OK. */
  pendingBatch: F[] | null;
  /** Whether the held mass upload keeps its files as project artifacts. */
  keepChoice: boolean;
  /** In a project: files waiting for the person to say where they go. */
  pendingDrop: F[] | null;
  dropChoice: DropDestination;
  rememberDrop: boolean;
  /** The destination this browser remembers for the project, shown so it can be changed. */
  remembered: DropDestination | null;
  /** Send was pressed while files were still being placed: send once they have uploaded. */
  sendWhenUploaded: boolean;
  listOpen: boolean;
  queueOpen: boolean;
  dragging: boolean;
  prompts: boolean;
  dictating: boolean;
  /** The microphone hears speech right now. */
  hearing: boolean;
  dictationError: string | null;
}

export function initialComposer<F extends NamedFile = NamedFile>(
  draft: string | undefined
): ComposerState<F> {
  return {
    text: draft ?? '',
    attachments: [],
    uploading: 0,
    uploadTotal: 0,
    ocrPending: 0,
    uploadError: null,
    pendingBatch: null,
    keepChoice: false,
    pendingDrop: null,
    dropChoice: 'project',
    rememberDrop: true,
    remembered: null,
    sendWhenUploaded: false,
    listOpen: false,
    queueOpen: false,
    dragging: false,
    prompts: false,
    dictating: false,
    hearing: false,
    dictationError: null,
  };
}

export type ComposerAction<F extends NamedFile = NamedFile> =
  | { type: 'typed'; text: string }
  /** An earlier prompt is being rewritten: its text fills the box. */
  | { type: 'editStarted'; text: string }
  | { type: 'editCancelled' }
  /** The caller took what was sent: the box and its files are cleared. */
  | { type: 'submitted' }
  // Files chosen — by the picker, a drop or a paste. Which of these three
  // follows is `filesChosen`'s call.
  | { type: 'destinationAsked'; files: F[] }
  | { type: 'batchHeld'; files: F[]; keep: boolean }
  | { type: 'uploadStarted'; files: F[]; keep: boolean }
  // The project question.
  | { type: 'rememberedLoaded'; choice: DropDestination | null }
  | { type: 'dropChoiceChanged'; choice: DropDestination }
  | { type: 'rememberDropChanged'; on: boolean }
  /** The person answered (Add, or Send): `inProject` lets a remembered answer be shown. */
  | { type: 'dropConfirmed'; inProject: boolean }
  | { type: 'dropCancelled' }
  | { type: 'dropForgotten' }
  // The mass-upload question.
  | { type: 'batchConfirmed' }
  | { type: 'batchCancelled' }
  // What the uploads answered.
  | { type: 'fileUploaded'; attachment: AttachmentView }
  | { type: 'fileFailed'; filename: string; error: string | null }
  /** Every file of one upload has been answered. */
  | { type: 'uploadSettled'; count: number }
  | { type: 'ocrStarted'; count: number }
  | {
      type: 'ocrAnswered';
      /** How many files this request carried. */
      count: number;
      results: { id: string; extractStatus: string }[];
    }
  | { type: 'attachmentRemoved'; id: string }
  /** Send was pressed while the project question was open: answer it, then send. */
  | { type: 'sendQueuedBehindUploads' }
  /** The send that waited on the uploads has gone. */
  | { type: 'sendAfterUploadTaken' }
  // Dialogs and the drop zone.
  | { type: 'listOpened' }
  | { type: 'listClosed' }
  | { type: 'queueOpened' }
  | { type: 'queueClosed' }
  | { type: 'queueLengthChanged'; length: number }
  | { type: 'dragOver' }
  | { type: 'dragEnded' }
  | { type: 'promptsOpened' }
  | { type: 'promptsClosed' }
  | { type: 'promptPicked'; body: string }
  // Dictation.
  | { type: 'dictationStarted' }
  | { type: 'speechHeard' }
  | { type: 'utteranceEnded' }
  | { type: 'spoken'; text: string }
  | { type: 'transcriptionFailed'; error: string }
  | { type: 'dictationStopped' }
  | { type: 'dictationFailed'; error: string };

/** What the box holds after dictation hears `spoken`: appended with one space, or the words alone. */
export function appendSpoken(current: string, spoken: string): string {
  return current.trim() ? `${current.replace(/\s+$/, '')} ${spoken}` : spoken;
}

/** A prompt from the library lands on a line of its own below what is typed. */
export function insertPrompt(current: string, body: string): string {
  return current ? `${current}\n${body}` : body;
}

function withAttachments<F extends NamedFile>(
  state: ComposerState<F>,
  attachments: AttachmentView[]
): ComposerState<F> {
  // An emptied list has nothing left to show in its dialog.
  return { ...state, attachments, listOpen: attachments.length === 0 ? false : state.listOpen };
}

export function composerReducer<F extends NamedFile>(
  state: ComposerState<F>,
  action: ComposerAction<F>
): ComposerState<F> {
  switch (action.type) {
    case 'typed':
      return { ...state, text: action.text };
    case 'editStarted':
      return { ...state, text: action.text };
    case 'editCancelled':
      return { ...state, text: '' };
    case 'submitted':
      return withAttachments({ ...state, text: '' }, []);
    case 'destinationAsked':
      // Each new question starts on "keep it in the project".
      return {
        ...state,
        dropChoice: 'project',
        pendingDrop: [...(state.pendingDrop ?? []), ...action.files],
      };
    case 'batchHeld':
      return {
        ...state,
        keepChoice: action.keep,
        pendingBatch: [...(state.pendingBatch ?? []), ...action.files],
      };
    case 'uploadStarted':
      return {
        ...state,
        keepChoice: action.keep,
        uploadError: null,
        uploading: state.uploading + action.files.length,
        uploadTotal: state.uploadTotal + action.files.length,
      };
    case 'rememberedLoaded':
      return { ...state, remembered: action.choice };
    case 'dropChoiceChanged':
      return { ...state, dropChoice: action.choice };
    case 'rememberDropChanged':
      return { ...state, rememberDrop: action.on };
    case 'dropConfirmed':
      if (!state.pendingDrop) return state;
      return {
        ...state,
        pendingDrop: null,
        remembered: action.inProject && state.rememberDrop ? state.dropChoice : state.remembered,
      };
    case 'dropCancelled':
      return { ...state, pendingDrop: null, sendWhenUploaded: false };
    case 'dropForgotten':
      return { ...state, remembered: null };
    case 'batchConfirmed': {
      const files = state.pendingBatch;
      if (!files) return state;
      return composerReducer(
        { ...state, pendingBatch: null },
        { type: 'uploadStarted', files, keep: state.keepChoice }
      );
    }
    case 'batchCancelled':
      return { ...state, pendingBatch: null, sendWhenUploaded: false };
    case 'fileUploaded':
      return withAttachments({ ...state, uploading: Math.max(0, state.uploading - 1) }, [
        ...state.attachments,
        action.attachment,
      ]);
    case 'fileFailed':
      return {
        ...state,
        uploading: Math.max(0, state.uploading - 1),
        uploadError: `${action.filename}: ${action.error ?? 'upload failed'}`,
      };
    case 'uploadSettled':
      return { ...state, uploadTotal: Math.max(0, state.uploadTotal - action.count) };
    case 'ocrStarted':
      return { ...state, ocrPending: state.ocrPending + action.count };
    case 'ocrAnswered': {
      const byId = new Map(action.results.map((result) => [result.id, result.extractStatus]));
      return {
        ...state,
        ocrPending: Math.max(0, state.ocrPending - action.count),
        attachments: state.attachments.map((entry) =>
          byId.has(entry.id) ? { ...entry, extractStatus: byId.get(entry.id) ?? '' } : entry
        ),
      };
    }
    case 'attachmentRemoved':
      return withAttachments(
        state,
        state.attachments.filter((entry) => entry.id !== action.id)
      );
    case 'sendQueuedBehindUploads':
      return { ...state, sendWhenUploaded: true };
    case 'sendAfterUploadTaken':
      return { ...state, sendWhenUploaded: false };
    case 'listOpened':
      return state.attachments.length > 0 ? { ...state, listOpen: true } : state;
    case 'listClosed':
      return { ...state, listOpen: false };
    case 'queueOpened':
      return { ...state, queueOpen: true };
    case 'queueClosed':
      return { ...state, queueOpen: false };
    case 'queueLengthChanged':
      // Down to one item (or none), that item belongs inline again, not behind a dialog.
      return action.length <= 1 ? { ...state, queueOpen: false } : state;
    case 'dragOver':
      return { ...state, dragging: true };
    case 'dragEnded':
      return { ...state, dragging: false };
    case 'promptsOpened':
      return { ...state, prompts: true };
    case 'promptsClosed':
      return { ...state, prompts: false };
    case 'promptPicked':
      return { ...state, prompts: false, text: insertPrompt(state.text, action.body) };
    case 'dictationStarted':
      return { ...state, dictating: true, hearing: false, dictationError: null };
    case 'speechHeard':
      return { ...state, hearing: true };
    case 'utteranceEnded':
      return { ...state, hearing: false };
    case 'spoken': {
      const spoken = action.text.trim();
      return spoken ? { ...state, text: appendSpoken(state.text, spoken) } : state;
    }
    case 'transcriptionFailed':
      return { ...state, dictationError: action.error };
    case 'dictationStopped':
      return { ...state, dictating: false, hearing: false };
    case 'dictationFailed':
      return { ...state, dictating: false, hearing: false, dictationError: action.error };
  }
}

/**
 * Where a choice of files goes. In a project whose destination this
 * browser does not remember, the person is asked first; otherwise past the
 * threshold (files staged, uploading and chosen together) they are asked
 * whether a mass upload is wanted — slow, and its files reach the model as
 * a list, not inline text; otherwise the files upload at once.
 */
export function filesChosen<F extends NamedFile>(
  state: ComposerState<F>,
  files: F[],
  context: { inProject: boolean; remembered: DropDestination | null; threshold: number }
): ComposerAction<F> | null {
  if (files.length === 0) return null;
  if (context.inProject && context.remembered === null) {
    return { type: 'destinationAsked', files };
  }
  return proceedWith(
    state,
    files,
    context.inProject && context.remembered === 'project',
    context.threshold
  );
}

/** The files the project question was answered for, and where they go: a mass upload still asks. */
export function proceedWith<F extends NamedFile>(
  state: ComposerState<F>,
  files: F[],
  keep: boolean,
  threshold: number
): ComposerAction<F> {
  if (state.attachments.length + state.uploading + files.length > threshold) {
    return { type: 'batchHeld', files, keep };
  }
  return { type: 'uploadStarted', files, keep };
}

/** Files are waiting for the person to say where they go. */
export function placing(state: ComposerState): boolean {
  return (state.pendingDrop?.length ?? 0) > 0;
}

/** Something to send — typed text, an attachment, or files being placed. */
export function hasDraft(state: ComposerState): boolean {
  return state.text.trim().length > 0 || state.attachments.length > 0 || placing(state);
}

/**
 * What Send does right now: nothing (disabled, an empty box, a file still
 * uploading); answer the open project question and send once the files
 * are up; or hand the trimmed text and the staged files to the caller —
 * who queues it while a reply runs.
 */
export type SendStep =
  { kind: 'nothing' } | { kind: 'placeThenSend' } | { kind: 'submit'; input: ComposerSubmit };

export function sendStep(state: ComposerState, disabled: boolean): SendStep {
  if (disabled) return { kind: 'nothing' };
  if (placing(state)) return { kind: 'placeThenSend' };
  const text = state.text.trim();
  if ((!text && state.attachments.length === 0) || state.uploading > 0) return { kind: 'nothing' };
  return { kind: 'submit', input: { text, attachments: state.attachments } };
}

/**
 * The send that waited on the files may go: the project question answered,
 * the mass upload's own warning answered, every upload finished.
 */
export function readyToSendAfterUpload(state: ComposerState): boolean {
  return (
    state.sendWhenUploaded &&
    !placing(state) &&
    !state.pendingBatch &&
    state.uploading === 0 &&
    state.uploadTotal === 0
  );
}

/**
 * The button in the send slot. Stop takes it ONLY while a reply runs and
 * there is nothing to send: the moment something is typed it is the blue
 * send button again, and pressing it queues — a thumb trained on "the
 * button on the right sends" must never stop the reply it meant to queue
 * behind.
 */
export type SendButton =
  { kind: 'stop' } | { kind: 'queue'; disabled: boolean } | { kind: 'send'; disabled: boolean };

export function sendButton(
  state: ComposerState,
  context: { running: boolean; disabled: boolean }
): SendButton {
  const draft = hasDraft(state);
  if (context.running && !draft) return { kind: 'stop' };
  const busy = context.disabled || state.uploading > 0;
  if (context.running) return { kind: 'queue', disabled: busy };
  return { kind: 'send', disabled: busy || !draft };
}

/** What the empty box says. */
export function placeholder(state: ComposerState, running: boolean): string {
  if (state.dictating) {
    return state.hearing
      ? 'Listening…'
      : 'Speak, then pause — your words land here to edit and send';
  }
  return running ? 'Replying… Enter queues the next message' : 'Message Renkei';
}

/** The staged files' row: chips or one counter chip, and what is still under way. */
export interface StagingRow {
  shown: boolean;
  /** A row of chips would crowd out the text box: one counter chip opens the full list. */
  folded: boolean;
  counter: string;
  uploading: string | null;
  ocr: string | null;
}

export function stagingRow(state: ComposerState): StagingRow {
  const count = state.attachments.length;
  return {
    shown: count > 0 || state.uploading > 0 || state.ocrPending > 0,
    folded: count >= FOLD_AT,
    counter: `${count} attachments`,
    uploading:
      state.uploading > 0
        ? `Uploading ${state.uploadTotal - state.uploading}/${state.uploadTotal}…`
        : null,
    ocr: state.ocrPending > 0 ? `Reading scans (${state.ocrPending} left)…` : null,
  };
}

/** The mass-upload warning's words for the held files. */
export function batchWarning(
  files: NamedFile[],
  threshold: number
): { title: string; detail: string; confirm: string } {
  return {
    title: `Add ${files.length} ${files.length === 1 ? 'file' : 'files'}? Large uploads take a while.`,
    detail: `More than ${threshold} files is a mass upload. Scanned PDFs and images are read with OCR after they upload, and the assistant gets a list of the files and reads each one as it needs to, rather than seeing them all at once.`,
    confirm: `Upload ${files.length} files`,
  };
}

/** The project question's heading: the file by name, or how many. */
export function dropQuestion(files: NamedFile[]): string {
  return `Where should ${files.length === 1 ? files[0].name : `these ${files.length} files`} go?`;
}

/** What the remembered-destination button says, for the project named. */
export function rememberedLabel(
  remembered: DropDestination,
  projectName: string
): { short: string; where: string } {
  return {
    short: remembered === 'project' ? 'Files → artifacts' : 'Files → message',
    where: remembered === 'project' ? `${projectName}’s artifacts` : 'this message only',
  };
}

/** The uploaded files still waiting on OCR, by id. */
export function needsOcr(stored: AttachmentView[]): string[] {
  return stored.filter((entry) => entry.extractStatus === 'needs_ocr').map((entry) => entry.id);
}

/** OCR requests for `ids`, at most OCR_BATCH files each, in order. */
export function ocrBatches(ids: string[], size: number = OCR_BATCH): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += size)
    batches.push(ids.slice(start, start + size));
  return batches;
}

/** How the queue shows above the box: one item inline, more as a summary that opens the list. */
export function queueRow(length: number): 'none' | 'inline' | 'summary' {
  if (length === 0) return 'none';
  return length === 1 ? 'inline' : 'summary';
}

/** A file's size the way a chip shows it. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the attachment list says about a file's text, or null when it was read. */
export function extractStatusLabel(status: string): string | null {
  if (status === 'done') return null;
  if (status === 'needs_ocr') return 'Waiting for OCR';
  if (status === 'ocr_failed') return 'OCR failed';
  return 'No text';
}
