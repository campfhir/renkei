'use client';

/**
 * "Save as image" for an SVG the model wrote: a PNG (drawn by the browser)
 * or the .svg file itself. Used under a fenced ```svg block, on the inline
 * mockup card and in the fullscreen viewer, so an SVG can be kept — not
 * just copied as text. What the buttons say and when they take a press is
 * svg-save-buttons.model.ts, tested in node.
 */

import { useReducer } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { saveSvg } from '@/lib/svg-image';
import { clientLogger } from '@/lib/client-logger';
import {
  SAVED_SHOWN_MS,
  SVG_SAVE_FORMATS,
  announcement,
  buttonFor,
  canStart,
  errorText,
  initSvgSave,
  svgSaveReducer,
  type SvgSaveFormat,
} from './svg-save-buttons.model';

export default function SvgSaveButtons({
  source,
  name,
  className,
  buttonClassName,
}: {
  source: string;
  /** What the file is called, minus the extension — a title is turned into a safe name. */
  name: string;
  className?: string;
  buttonClassName: string;
}) {
  const [state, dispatch] = useReducer(svgSaveReducer, undefined, initSvgSave);

  const save = async (format: SvgSaveFormat) => {
    if (!canStart(state)) return;
    dispatch({ type: 'started' });
    try {
      await saveSvg(source, name, format);
      dispatch({ type: 'saved', format });
      window.setTimeout(() => dispatch({ type: 'saved-shown' }), SAVED_SHOWN_MS);
    } catch (error) {
      clientLogger.error('chat/svg-save', 'could not save the image', error, { format });
      dispatch({ type: 'failed', message: error instanceof Error ? error.message : null });
    }
  };

  const error = errorText(state);
  return (
    <span role="group" aria-label="Save as image" className={className}>
      {SVG_SAVE_FORMATS.map((format) => {
        const button = buttonFor(state, format);
        return (
          <button
            key={format}
            type="button"
            disabled={button.disabled}
            onClick={() => void save(format)}
            aria-label={button.label}
            title={button.label}
            className={buttonClassName}
          >
            <Icon
              path={button.icon === 'check' ? ICONS.check : ICONS.download}
              className="h-3.5 w-3.5"
            />
            {button.text}
          </button>
        );
      })}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement(state)}
      </span>
      {error !== null ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}
