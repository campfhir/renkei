'use client';

/**
 * The instruction editor: prose with atomic chips.
 *
 * A single contenteditable paragraph whose chips are non-editable spans —
 * the only structure a step instruction needs, and the reason this is a
 * ~350-line component instead of an editor dependency. The SOURCE OF TRUTH
 * is the `InstructionSegment[]` prop: the DOM is read back into segments on
 * every input, and rebuilt from props only when they diverge from what was
 * last emitted (ref-tracked), which is what keeps the caret out of fights
 * with React.
 *
 * Containment rules that keep contenteditable honest:
 *   - paste lands as plain text, Enter is blocked (single block),
 *     formatting inputTypes are refused in beforeinput;
 *   - IME composition pauses DOM→segment reads until compositionend;
 *   - Backspace against a chip selects it first, deletes it second —
 *     the standard token-field affordance — and every chip carries ×.
 *
 * Autocomplete: typing `/` opens the insert menu and the characters after
 * it filter it (they remain visible in the text until a pick replaces
 * them); the persistent "+ Insert" button opens the same menu for people
 * who will never learn a keystroke. Selection is keyboard-complete
 * (arrows/Enter/Escape, aria-activedescendant).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { InstructionSegment } from '@renkei/agents';
import { InsertMenu, flattenOptions, optionDomId } from './insert-menu';
import { dateOptions, type InsertOption, type ToolOption, type VariableOption } from './options';
import { describeDateSegment, isInstructionSegment } from '@renkei/agents';

export interface ChipEditorProps {
  value: InstructionSegment[];
  onChange: (segments: InstructionSegment[]) => void;
  tools: ToolOption[];
  variables: VariableOption[];
  /**
   * How many tool chips this editor accepts (1 for a step body, more for
   * corrective guidance). At the limit the menu's tool section becomes a
   * hint naming the chip to remove.
   */
  maxTools: number;
  placeholder: string;
  ariaLabel: string;
  /** Variable names that no longer resolve (a trigger was removed). */
  invalidVars?: ReadonlySet<string>;
}

function segmentsEqual(a: InstructionSegment[], b: InstructionSegment[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((segment, index) => {
    const other = b[index];
    if (segment.t !== other.t) return false;
    if (segment.t === 'text' && other.t === 'text') return segment.v === other.v;
    // A date chip is its parameters; compare them rather than a name it
    // does not have.
    if (segment.t === 'date' || other.t === 'date') {
      return JSON.stringify(segment) === JSON.stringify(other);
    }
    return segment.t !== 'text' && other.t !== 'text' && segment.name === other.name;
  });
}

export function ChipEditor({
  value,
  onChange,
  tools,
  variables,
  maxTools,
  placeholder,
  ariaLabel,
  invalidVars,
}: ChipEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<InstructionSegment[] | null>(null);
  const composing = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** True when the menu was opened by the button and owns a search box. */
  const [searchMode, setSearchMode] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  /** Length of the `/query` text to replace when a pick lands. */
  const slashLength = useRef<number | null>(null);
  /** The caret at menu-open time — the search box steals focus, so the
   *  insertion point must be remembered and restored. */
  const savedRange = useRef<Range | null>(null);
  const [selectedChip, setSelectedChip] = useState<HTMLElement | null>(null);
  const listboxId = useId().replace(/[^a-zA-Z0-9-]/g, '');

  const labelFor = useCallback(
    (
      segment: Extract<InstructionSegment, { t: 'tool' } | { t: 'var' } | { t: 'date' }>
    ): string => {
      if (segment.t === 'tool') {
        return tools.find((tool) => tool.name === segment.name)?.label ?? segment.name;
      }
      // Derived from the parameters, never stored beside them, so the pill
      // cannot drift from what the chip actually resolves to.
      if (segment.t === 'date') return describeDateSegment(segment);
      return variables.find((variable) => variable.name === segment.name)?.label ?? segment.name;
    },
    [tools, variables]
  );

  const chipElement = useCallback(
    (
      segment: Extract<InstructionSegment, { t: 'tool' } | { t: 'var' } | { t: 'date' }>
    ): HTMLSpanElement => {
      const chip = document.createElement('span');
      chip.setAttribute('data-chip', '');
      chip.setAttribute('data-chip-kind', segment.t);
      // A date chip has no name to resolve later — its meaning IS its
      // parameters, so they ride on the element and round-trip verbatim.
      if (segment.t === 'date') {
        chip.setAttribute('data-chip-date', JSON.stringify(segment));
        chip.setAttribute('data-chip-name', describeDateSegment(segment));
      } else {
        chip.setAttribute('data-chip-name', segment.name);
      }
      chip.contentEditable = 'false';
      if (segment.t !== 'date' && segment.t === 'var' && invalidVars?.has(segment.name)) {
        chip.setAttribute('data-chip-invalid', '');
        chip.title = 'This detail is no longer provided — remove the chip or re-add its trigger.';
      }
      const label = document.createElement('span');
      label.textContent = labelFor(segment);
      chip.appendChild(label);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${labelFor(segment)}`);
      remove.textContent = '×';
      chip.appendChild(remove);
      return chip;
    },
    [labelFor, invalidVars]
  );

  const readSegments = useCallback((): InstructionSegment[] => {
    const root = rootRef.current;
    if (!root) return [];
    const segments: InstructionSegment[] = [];
    const pushText = (text: string) => {
      if (!text) return;
      const last = segments[segments.length - 1];
      if (last && last.t === 'text') last.v += text;
      else segments.push({ t: 'text', v: text });
    };
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        pushText(node.textContent ?? '');
        continue;
      }
      if (node instanceof HTMLElement && node.hasAttribute('data-chip')) {
        const kind = node.getAttribute('data-chip-kind');
        const name = node.getAttribute('data-chip-name') ?? '';
        if ((kind === 'tool' || kind === 'var') && name) segments.push({ t: kind, name });
        if (kind === 'date') {
          const raw = node.getAttribute('data-chip-date');
          const parsed: unknown = raw ? JSON.parse(raw) : null;
          // Structurally checked on the way back in: a hand-edited DOM (or a
          // paste) must not smuggle a malformed chip into the document.
          if (isInstructionSegment(parsed) && parsed.t === 'date') segments.push(parsed);
        }
        continue;
      }
      // Anything else (a <br>, a pasted element that slipped through) reads
      // as its text; structure never survives.
      pushText(node.textContent ?? '');
    }
    return segments;
  }, []);

  const rebuildDom = useCallback(
    (segments: InstructionSegment[]) => {
      const root = rootRef.current;
      if (!root) return;
      root.textContent = '';
      for (const segment of segments) {
        if (segment.t === 'text') root.appendChild(document.createTextNode(segment.v));
        else root.appendChild(chipElement(segment));
      }
    },
    [chipElement]
  );

  // Props → DOM, only when the outside world actually changed the value.
  useEffect(() => {
    if (lastEmitted.current !== null && segmentsEqual(lastEmitted.current, value)) return;
    lastEmitted.current = value;
    rebuildDom(value);
  }, [value, rebuildDom]);

  const emit = useCallback(() => {
    const segments = readSegments();
    lastEmitted.current = segments;
    onChange(segments);
  }, [onChange, readSegments]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setSearchMode(false);
    setQuery('');
    setActiveIndex(0);
    slashLength.current = null;
    savedRange.current = null;
  }, []);

  const toolCount = value.filter((segment) => segment.t === 'tool').length;
  const toolsBlocked = toolCount >= maxTools;
  const blockedHint = toolsBlocked
    ? maxTools === 1
      ? 'This step already uses a skill — remove that chip to choose a different one.'
      : 'This guidance has reached its skill limit.'
    : null;
  // The caller's timezone is the one thing this cannot infer and the model
  // must not guess, so it is read from the browser at insert time.
  const dates = useMemo(
    () => dateOptions(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', query),
    [query]
  );
  const options = flattenOptions(tools, variables, dates, toolsBlocked, query);

  const insertOption = useCallback(
    (option: InsertOption) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      const selection = window.getSelection();
      if (!selection) return;
      // The search box (or a click) may have taken the selection out of
      // the editor — the caret from menu-open time is the insertion point.
      if (
        savedRange.current &&
        (selection.rangeCount === 0 || !root.contains(selection.anchorNode))
      ) {
        selection.removeAllRanges();
        selection.addRange(savedRange.current);
      }
      if (selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      range.collapse(true);

      // Replace the typed `/query` (when the menu was opened by slash).
      const toDelete = slashLength.current;
      if (toDelete !== null && range.startContainer.nodeType === Node.TEXT_NODE) {
        const textNode = range.startContainer;
        const end = range.startOffset;
        const start = Math.max(0, end - toDelete);
        const deletion = document.createRange();
        deletion.setStart(textNode, start);
        deletion.setEnd(textNode, end);
        deletion.deleteContents();
        range.setStart(textNode, start);
        range.collapse(true);
      }

      const chip = chipElement(
        option.kind === 'tool'
          ? { t: 'tool', name: option.name }
          : option.kind === 'date'
            ? option.segment
            : { t: 'var', name: option.name }
      );
      range.insertNode(chip);
      const space = document.createTextNode(' ');
      chip.after(space);
      range.setStartAfter(space);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      closeMenu();
      emit();
    },
    [chipElement, closeMenu, emit]
  );

  const chipBefore = (): HTMLElement | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    if (container.nodeType === Node.TEXT_NODE && range.startOffset > 0) return null;
    let candidate: Node | null = null;
    if (container === rootRef.current) {
      candidate = rootRef.current.childNodes[range.startOffset - 1] ?? null;
    } else if (container.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
      candidate = container.previousSibling;
    }
    return candidate instanceof HTMLElement && candidate.hasAttribute('data-chip')
      ? candidate
      : null;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (options.length > 0) {
          setActiveIndex((current) => {
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            return (current + delta + options.length) % options.length;
          });
        }
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const option = options[activeIndex];
        if (option) insertOption(option);
        else closeMenu();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
        return;
      }
    }

    if (event.key === 'Enter') {
      // Single-block instructions; Enter would fragment the DOM into divs.
      event.preventDefault();
      return;
    }

    if (event.key === '/' && !menuOpen && !composing.current) {
      // The slash itself is typed into the text; a pick replaces it.
      setMenuOpen(true);
      setQuery('');
      setActiveIndex(0);
      slashLength.current = 1;
      return;
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      if (selectedChip) {
        event.preventDefault();
        selectedChip.remove();
        setSelectedChip(null);
        emit();
        return;
      }
      if (event.key === 'Backspace') {
        const chip = chipBefore();
        if (chip) {
          event.preventDefault();
          chip.classList.add('chip-selected');
          setSelectedChip(chip);
          return;
        }
      }
    } else if (selectedChip) {
      selectedChip.classList.remove('chip-selected');
      setSelectedChip(null);
    }
  };

  const handleInput = () => {
    if (composing.current) return;
    if (menuOpen && slashLength.current !== null) {
      // The characters after the slash both show in the text and filter
      // the menu; read them back from the caret's text node.
      const selection = window.getSelection();
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
        const text = range.startContainer.textContent ?? '';
        const upto = text.slice(0, range.startOffset);
        const slashAt = upto.lastIndexOf('/');
        if (slashAt >= 0) {
          const typed = upto.slice(slashAt + 1);
          setQuery(typed);
          setActiveIndex(0);
          slashLength.current = typed.length + 1;
        } else {
          closeMenu();
        }
      } else {
        closeMenu();
      }
    }
    emit();
  };

  const handleBeforeInput = (event: React.FormEvent<HTMLDivElement>) => {
    // Refuse rich-text input types (bold, lists, drops of HTML).
    const native = event.nativeEvent;
    const inputType = native instanceof InputEvent ? native.inputType : '';
    if (inputType.startsWith('format') || inputType === 'insertFromDrop') {
      event.preventDefault();
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text.replace(/\s+/g, ' '));
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    emit();
  };

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const chip = target.closest('[data-chip]');
    if (chip instanceof HTMLElement && target.closest('button')) {
      chip.remove();
      setSelectedChip(null);
      emit();
    }
  };

  return (
    <div className="relative">
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline="false"
        aria-label={ariaLabel}
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? listboxId : undefined}
        aria-activedescendant={
          menuOpen && options.length > 0 ? optionDomId(listboxId, activeIndex) : undefined
        }
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className="chip-editor w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        onBeforeInput={handleBeforeInput}
        onPaste={handlePaste}
        onClick={handleClick}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          emit();
        }}
        onBlur={(event) => {
          // A click inside the menu steals focus via mousedown-prevented
          // buttons, so blur here means the user truly left.
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.parentElement?.contains(event.relatedTarget)
          ) {
            closeMenu();
            if (selectedChip) {
              selectedChip.classList.remove('chip-selected');
              setSelectedChip(null);
            }
          }
        }}
      />
      <div className="mt-1 flex items-center justify-between">
        <button
          type="button"
          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          onClick={() => {
            const root = rootRef.current;
            if (!root) return;
            root.focus();
            // No saved caret? Put it at the end so the chip lands visibly.
            const selection = window.getSelection();
            if (selection && (selection.rangeCount === 0 || !root.contains(selection.anchorNode))) {
              const range = document.createRange();
              range.selectNodeContents(root);
              range.collapse(false);
              selection.removeAllRanges();
              selection.addRange(range);
            }
            // The search box is about to take focus; remember where the
            // chip should land.
            savedRange.current =
              selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
            slashLength.current = null;
            setMenuOpen(true);
            setSearchMode(true);
            setQuery('');
            setActiveIndex(0);
          }}
        >
          + Insert a skill or detail
        </button>
        <span className="text-[0.65rem] text-gray-400">type / to insert</span>
      </div>
      {menuOpen ? (
        <InsertMenu
          query={query}
          onQueryChange={(next) => {
            setQuery(next);
            setActiveIndex(0);
          }}
          withSearchBox={searchMode}
          tools={tools}
          variables={variables}
          dates={dates}
          toolsBlockedHint={blockedHint}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onSelect={insertOption}
          onNavigate={(delta) => {
            if (options.length > 0) {
              setActiveIndex((current) => (current + delta + options.length) % options.length);
            }
          }}
          onCommit={() => {
            const option = options[activeIndex];
            if (option) insertOption(option);
            else closeMenu();
          }}
          onClose={closeMenu}
          listboxId={listboxId}
        />
      ) : null}
    </div>
  );
}
