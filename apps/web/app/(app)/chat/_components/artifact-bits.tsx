'use client';

/**
 * The small pieces every artifacts surface shares: the type badge that
 * stands in for a per-format icon (the icon set has none for PDF, PPTX
 * or code), the Always / On demand switch, sizes and statuses as words.
 */

export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function tokensLabel(tokens: number): string {
  return tokens >= 1000
    ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens`
    : `${tokens} tokens`;
}

export function extensionOf(filename: string, contentType: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && dot < filename.length - 1)
    return filename
      .slice(dot + 1)
      .toUpperCase()
      .slice(0, 5);
  if (contentType.startsWith('image/')) return 'IMG';
  if (contentType === 'application/pdf') return 'PDF';
  if (contentType.startsWith('text/')) return 'TXT';
  return 'FILE';
}

const TONES: Record<string, string> = {
  PDF: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  DOCX: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  DOC: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  PPTX: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  XLSX: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  CSV: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  PNG: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  JPG: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  JPEG: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  GIF: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  IMG: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  SQL: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
};
const PLAIN = 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';

export function TypeBadge({
  filename,
  contentType,
  large = false,
}: {
  filename: string;
  contentType: string;
  large?: boolean;
}) {
  const label = extensionOf(filename, contentType);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded font-mono font-semibold tracking-wide ${large ? 'h-7 w-11 text-[11px]' : 'h-[22px] w-9 text-[10px]'} ${TONES[label] ?? PLAIN}`}
    >
      {label.length > 4 ? label.slice(0, 4) : label}
    </span>
  );
}

export function statusLabel(status: string): string | null {
  switch (status) {
    case 'done':
      return null;
    case 'needs_ocr':
      return 'Waiting for OCR';
    case 'ocr_failed':
      return 'OCR failed';
    case 'unsupported':
      return 'No text to read';
    case 'too_large':
      return 'Too large to read';
    case 'failed':
      return 'Text extraction failed';
    default:
      return 'No text';
  }
}

export type Mode = 'always' | 'on_demand';

/** Always / On demand, as the segmented switch the code pane uses for Chat / Code. */
export function ModeToggle({
  value,
  onChange,
  disabled,
  label,
}: {
  value: Mode;
  onChange: (mode: Mode) => void;
  disabled?: boolean;
  label: string;
}) {
  const option = (mode: Mode, text: string, title: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === mode}
      data-tip={title}
      disabled={disabled}
      onClick={() => value !== mode && onChange(mode)}
      className={`flex h-6 items-center rounded-md px-2 text-[11px] font-medium disabled:cursor-default ${
        value === mode
          ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-950 dark:text-gray-100'
          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
    >
      {text}
    </button>
  );
  return (
    <span
      role="radiogroup"
      aria-label={label}
      className="flex shrink-0 rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800"
    >
      {option('always', 'Always', 'Its full text travels with every turn')}
      {option('on_demand', 'On demand', 'Searched and read when a question calls for it')}
    </span>
  );
}
