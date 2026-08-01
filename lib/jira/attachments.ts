/**
 * Turning a model-supplied attachment into bytes Jira will accept.
 *
 * **Content arrives as base64 in the tool call. There is deliberately no
 * "path" argument.** A filesystem path would read the *server's* disk, not the
 * caller's: on the gateway that is every other tenant's process, and even on
 * the stdio harness it would hand a model a general file-read primitive
 * pointed at the operator's home directory — including `~/.renkei/tokens.json`,
 * whose contents would then be uploaded to a shared Jira issue. Base64 keeps
 * the bytes coming from the client, which is the only party that should be
 * choosing them, and behaves identically on both transports.
 *
 * The cost is real and worth stating: base64 inflates the JSON-RPC message by
 * a third, so the size cap is low by design and large files are out of scope.
 */

/** Extensions worth naming. Everything else uploads as a generic binary. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: 'text/csv',
  gif: 'image/gif',
  har: 'application/json',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  log: 'text/plain',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
};

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** `type/subtype` with only the characters RFC 6838 allows in a token. */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;

/** Standard and URL-safe base64, with or without padding. */
const BASE64_PATTERN = /^[A-Za-z0-9+/\-_]*={0,2}$/;

/** `data:image/png;base64,AAAA` — models produce these when handed an image. */
const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w-]+=[^;,]*)*;base64,/i;

/**
 * Jira truncates past 255, and a name that long is unreadable in the UI
 * anyway. Leave room for the de-duplicating suffix Jira appends on collision.
 */
const MAX_FILENAME_LENGTH = 200;

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export interface AttachmentInput {
  filename: string;
  /** Raw base64, or a `data:` URL. */
  contentBase64: string;
  /** Overrides what the extension implies. */
  contentType?: string | undefined;
}

export interface DecodedAttachment {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * Reduces whatever the model passed to a safe basename.
 *
 * Path separators are stripped rather than rejected, because a model that has
 * just read `/var/log/app.log` will naturally pass the whole path and means
 * `app.log`. Traversal is not a risk against Jira's API — the filename is a
 * multipart field, not a path — but a name containing a separator, a quote, or
 * a newline is exactly what a multipart header injection would look like, so
 * none of them survive.
 */
export function sanitizeFilename(raw: string): string {
  const basename = raw.split(/[\\/]/).pop() ?? '';

  const cleaned = basename
    // Control characters, CR/LF, and the quote that delimits the multipart
    // filename parameter.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim();

  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new AttachmentError(`\`${raw}\` does not contain a usable filename.`);
  }

  if (cleaned.length <= MAX_FILENAME_LENGTH) {
    return cleaned;
  }

  // Truncate the stem, not the extension: the extension is what decides how
  // Jira previews the file and what content type is inferred below.
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
}

export function inferContentType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) {
    return DEFAULT_CONTENT_TYPE;
  }
  return CONTENT_TYPES[filename.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Validates and decodes one attachment.
 *
 * The size limit is checked against the encoded length before anything is
 * decoded, so an oversized payload is refused without first materializing it
 * as a Buffer.
 */
export function decodeAttachment(input: AttachmentInput, maxBytes: number): DecodedAttachment {
  const filename = sanitizeFilename(input.filename);

  const dataUrl = DATA_URL.exec(input.contentBase64);
  const encoded = (dataUrl ? input.contentBase64.slice(dataUrl[0].length) : input.contentBase64)
    // Models wrap long base64 across lines; whitespace is not part of the data.
    .replace(/\s+/g, '');

  if (encoded === '') {
    throw new AttachmentError(`${filename} has no content — contentBase64 is empty.`);
  }
  if (!BASE64_PATTERN.test(encoded)) {
    throw new AttachmentError(
      `${filename} is not valid base64. Pass the file's bytes base64-encoded, not its text.`,
    );
  }

  // Ceiling of the decoded size. Buffer.from silently discards trailing garbage
  // rather than throwing, so bounding the input is what actually enforces this.
  const approximateBytes = Math.floor((encoded.length * 3) / 4);
  if (approximateBytes > maxBytes) {
    throw new AttachmentError(
      `${filename} is about ${describeBytes(approximateBytes)}, over the ` +
        `${describeBytes(maxBytes)} limit. Upload it to Jira directly.`,
    );
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0) {
    throw new AttachmentError(`${filename} decoded to zero bytes.`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new AttachmentError(
      `${filename} is ${describeBytes(bytes.byteLength)}, over the ` +
        `${describeBytes(maxBytes)} limit.`,
    );
  }

  const contentType = input.contentType ?? dataUrl?.[1] ?? inferContentType(filename);
  if (!CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new AttachmentError(`\`${contentType}\` is not a valid content type for ${filename}.`);
  }

  return { filename, contentType, bytes };
}

/** Builds the `multipart/form-data` body both upload endpoints expect. */
export function toFormData(attachment: DecodedAttachment, field = 'file'): FormData {
  const form = new FormData();
  // Buffer is a Uint8Array view, which may sit inside a larger pooled
  // allocation — slice to this attachment's own bytes before handing it over.
  const view = attachment.bytes.subarray();
  form.append(field, new Blob([view], { type: attachment.contentType }), attachment.filename);
  return form;
}

export function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
