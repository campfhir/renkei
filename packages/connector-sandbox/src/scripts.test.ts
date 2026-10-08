/**
 * The bounds and names a script run is held to: what is refused before
 * anything is copied or spawned, how two inputs with one name are told
 * apart, and what a file a script wrote is staged as.
 */

import {
  SCRIPT_CODE_MAX_CHARS,
  SCRIPT_DEFAULT_TIMEOUT_MS,
  SCRIPT_MAX_INPUT_FILES,
  SCRIPT_MAX_TIMEOUT_MS,
  inputNamesFor,
  outputMediaType,
  scriptTimeoutMs,
  validateInputFileIds,
  validateOutputName,
  validateScriptCode,
} from './scripts';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('validateScriptCode', () => {
  it('takes a script and refuses an empty, oversized or null-bearing one', () => {
    expect(validateScriptCode('print(1)')).toEqual({ ok: true, code: 'print(1)' });
    expect(validateScriptCode('   ').ok).toBe(false);
    expect(validateScriptCode(undefined).ok).toBe(false);
    expect(validateScriptCode('x'.repeat(SCRIPT_CODE_MAX_CHARS + 1)).ok).toBe(false);
    expect(validateScriptCode('print(1)\0').ok).toBe(false);
  });
});

describe('scriptTimeoutMs', () => {
  it('defaults, floors at a second and caps at the ceiling', () => {
    expect(scriptTimeoutMs(undefined)).toBe(SCRIPT_DEFAULT_TIMEOUT_MS);
    expect(scriptTimeoutMs(-5)).toBe(SCRIPT_DEFAULT_TIMEOUT_MS);
    expect(scriptTimeoutMs(10)).toBe(1_000);
    expect(scriptTimeoutMs(5_000)).toBe(5_000);
    expect(scriptTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(SCRIPT_MAX_TIMEOUT_MS);
  });
});

describe('validateInputFileIds', () => {
  it('reads absent or empty as "every staged file"', () => {
    expect(validateInputFileIds(undefined)).toEqual({ ok: true, ids: null });
    expect(validateInputFileIds([])).toEqual({ ok: true, ids: null });
  });

  it('keeps distinct UUIDs in order and drops repeats', () => {
    expect(validateInputFileIds([ID_A, ID_B, ID_A])).toEqual({ ok: true, ids: [ID_A, ID_B] });
  });

  it('refuses a non-list, a non-id and too many', () => {
    expect(validateInputFileIds('abc').ok).toBe(false);
    expect(validateInputFileIds([ID_A, 'report.xlsx']).ok).toBe(false);
    expect(validateInputFileIds([ID_A, '../etc/passwd']).ok).toBe(false);
    const many = Array.from({ length: SCRIPT_MAX_INPUT_FILES + 1 }, (_, index) =>
      ID_A.replace(/^........?/, index.toString(16).padStart(8, '0'))
    );
    expect(validateInputFileIds(many).ok).toBe(false);
  });
});

describe('inputNamesFor', () => {
  it('keeps a unique name and numbers a repeat before its extension', () => {
    const names = inputNamesFor([
      { id: ID_A, filename: 'report.xlsx' },
      { id: ID_B, filename: 'report.xlsx' },
      { id: '33333333-3333-4333-8333-333333333333', filename: 'REPORT.XLSX' },
      { id: '44444444-4444-4444-8444-444444444444', filename: 'notes' },
      { id: '55555555-5555-4555-8555-555555555555', filename: 'notes' },
    ]);
    expect([...names.values()]).toEqual([
      'report.xlsx',
      'report (2).xlsx',
      'REPORT (3).XLSX',
      'notes',
      'notes (2)',
    ]);
  });

  it('falls back to the id for a name that is not a safe filename', () => {
    const names = inputNamesFor([{ id: ID_A, filename: '../escape' }]);
    expect(names.get(ID_A)).toBe(ID_A);
  });
});

describe('outputMediaType / validateOutputName', () => {
  it('types the common data formats by extension and the rest as bytes', () => {
    expect(outputMediaType('matched.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(outputMediaType('rows.CSV')).toBe('text/csv');
    expect(outputMediaType('summary.json')).toBe('application/json');
    expect(outputMediaType('model.bin')).toBe('application/octet-stream');
    expect(outputMediaType('noext')).toBe('application/octet-stream');
  });

  it('refuses a hidden file or an unsafe name as an output', () => {
    expect(validateOutputName('matched.xlsx')).toEqual({ ok: true, filename: 'matched.xlsx' });
    expect(validateOutputName('.cache').ok).toBe(false);
    expect(validateOutputName('a/b.csv').ok).toBe(false);
    expect(validateOutputName('..').ok).toBe(false);
  });
});
