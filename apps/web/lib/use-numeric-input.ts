'use client';

/**
 * A number field that may be EMPTY — or just "-" — while it is being typed.
 *
 * The obvious controlled-number pattern is
 * `value={n} onChange={e => set(Number(e.target.value) || 0)}`, and it makes
 * some numbers untypeable. To reach -3 from 1 you must first type "-", which
 * parses to NaN, falls back to 0, and takes the minus sign with it; the next
 * keystroke gives you 3. Clearing the field is impossible for the same
 * reason — it snaps back to 0 before you can type the replacement.
 *
 * So the TEXT is the state while the field has focus, and the number is
 * committed only when the text actually parses. Empty and "-" are valid
 * things to be typing; they are not valid things to leave behind, which is
 * what `onBlur` is for — it normalizes (clamping, if the caller asked) and
 * falls back to the last good value rather than writing NaN.
 *
 * Kept generic because two fields need it with different rules: the date
 * chip's offset accepts negatives and has no bounds, the step's tries are
 * positive and capped by the org.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * The number a piece of typed text commits to, or null while it is still
 * being typed. "" and "-" are the two states that mean "not yet": `Number('')`
 * is 0 and `Number('-')` is NaN, and committing either loses what the author
 * was in the middle of writing.
 */
export function typedNumber(text: string): number | null {
  if (text.trim() === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * What the field should hold once focus leaves: the typed number normalized,
 * or the last good value when nothing usable was typed. Empty is valid to be
 * typing, never valid to leave behind.
 */
export function settledNumber(
  text: string,
  fallback: number,
  normalize: (candidate: number) => number = (candidate) => candidate
): number {
  const typed = typedNumber(text);
  return typed === null ? fallback : normalize(typed);
}

export interface NumericInputBinding {
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
}

export function useNumericInput(
  value: number,
  commit: (next: number) => void,
  /** Applied on blur only, so it never fights the keystrokes. */
  normalize: (candidate: number) => number = (candidate) => candidate
): NumericInputBinding {
  const [text, setText] = useState(() => String(value));
  // Only a change coming from OUTSIDE should overwrite what is being typed.
  // Without this guard, committing on each keystroke would echo back and
  // rewrite the field ("-3" becoming "-3" is harmless; "1." becoming "1" is
  // not).
  const lastCommitted = useRef(value);

  useEffect(() => {
    if (lastCommitted.current === value) return;
    lastCommitted.current = value;
    setText(String(value));
  }, [value]);

  return {
    value: text,
    onChange: (next: string) => {
      setText(next);
      const typed = typedNumber(next);
      if (typed === null) return;
      lastCommitted.current = typed;
      commit(typed);
    },
    onBlur: () => {
      const next = settledNumber(text, value, normalize);
      lastCommitted.current = next;
      setText(String(next));
      if (next !== value) commit(next);
    },
  };
}
