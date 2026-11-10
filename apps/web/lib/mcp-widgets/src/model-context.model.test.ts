/**
 * What a decided card tells the model (model-context.model.ts).
 */

import { ANSWER_MAX_CHARS, answerText, modelContextBlocks } from './model-context.model';

const SENTENCE =
  'The user confirmed the Zoom meeting preview; "Mirth Errors Review" was scheduled for 2026-11-10T11:30:00.';
const ANSWER =
  'Scheduled "Mirth Errors Review" at 2026-11-10T19:30:00Z (id 88123456789).\nJoin: https://zoom.us/j/88123456789';

describe('a card whose decision ran a tool', () => {
  it('hands the model the tool’s answer after its own sentence: the id and the join link', () => {
    const blocks = modelContextBlocks(SENTENCE, {
      tool: 'zoom_create_meeting_confirm',
      text: ANSWER,
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: SENTENCE });
    expect(blocks[1]?.text).toContain('zoom_create_meeting_confirm');
    expect(blocks[1]?.text).toContain('id 88123456789');
    expect(blocks[1]?.text).toContain('https://zoom.us/j/88123456789');
  });

  it('tells the model the person did not see it, so it does not ask them for it', () => {
    const [, extra] = modelContextBlocks(SENTENCE, {
      tool: 'zoom_create_meeting_confirm',
      text: ANSWER,
    });
    expect(extra?.text).toMatch(/saw only the card's receipt/);
    expect(extra?.text).toMatch(/rather than asking/);
  });

  it('does not say twice what the card’s sentence already carries', () => {
    const sentence = `Created. ${ANSWER}`;
    expect(
      modelContextBlocks(sentence, { tool: 'jira_create_issue_confirm', text: ANSWER })
    ).toEqual([{ type: 'text', text: sentence }]);
  });

  it('cuts a very long answer rather than crowding out the card’s sentence', () => {
    const long = 'x'.repeat(ANSWER_MAX_CHARS + 500);
    const [, extra] = modelContextBlocks(SENTENCE, { tool: 'some_confirm', text: long });
    expect(extra?.text.endsWith('… (cut)')).toBe(true);
    expect(extra?.text.length).toBeLessThan(ANSWER_MAX_CHARS + 300);
  });
});

describe('a card whose decision ran nothing', () => {
  it('says only its own sentence when the person cancelled', () => {
    const cancelled =
      'The user cancelled the Zoom meeting from the preview card. Nothing was created.';
    expect(modelContextBlocks(cancelled, null)).toEqual([{ type: 'text', text: cancelled }]);
  });

  it('adds nothing for a tool that answered with no text', () => {
    expect(modelContextBlocks(SENTENCE, { tool: 'some_confirm', text: '  ' })).toHaveLength(1);
  });
});

describe('a tool answer’s text', () => {
  it('is every text block, one per line, and nothing else', () => {
    expect(
      answerText([
        { type: 'text', text: 'Scheduled.' },
        { type: 'image' },
        { type: 'text', text: 'Join: https://zoom.us/j/1' },
      ])
    ).toBe('Scheduled.\nJoin: https://zoom.us/j/1');
    expect(answerText(undefined)).toBe('');
  });
});
