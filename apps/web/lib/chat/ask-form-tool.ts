/**
 * chat_ask_form — the model's way to ask the person several things at
 * once, as a form drawn in the thread: radio buttons for one of a few
 * options, checkboxes for several, text, long text, number and date boxes,
 * each with its help and a required mark.
 *
 * The call ends the turn, like chat_task_wait does: nothing is to be
 * guessed while the form waits, and the person's answers are sent back as
 * their next message ("My answers: Q: … A: …"), which opens the next turn
 * as any message does — so a form can wait an hour or a day, across a
 * reload, with no turn held open. The tool keeps nothing itself: the
 * questions ride in the call's own input, which the chat already stores,
 * and the card is drawn from there (ask-form-card.tsx).
 *
 * Every chat has it. It changes nothing, so it never asks permission; it is
 * withheld from sub-agents (chat-delegate.ts) because they have no thread
 * to draw a form in.
 */

import { MAX_ASKED_QUESTIONS } from '@renkei/agents';
import { ASK_FORM_TOOL, parseAskFormRequest } from './ask-form';
import { END_TURN_META, errorResult, textResult, type LocalTool } from './local-tools';

export function askFormTools(): LocalTool[] {
  return [
    {
      def: {
        name: ASK_FORM_TOOL,
        description:
          'Ask the person several questions at once as a form in the chat, and wait for their ' +
          'answers. Use it when you need information only they have and a plain question would ' +
          'be tedious to answer in prose: a choice between options, several details, a ' +
          'preference, a date or a number. This ends your turn — do not guess the answers or ' +
          'carry on; their answers arrive as their next message. Ask only what you need now, ' +
          `at most ${MAX_ASKED_QUESTIONS} questions, each one complete sentence. ` +
          'Question types: "choice" shows the options as radio buttons (pick one), "multi" as ' +
          'checkboxes (pick several), "text" a short box, "longtext" a larger one, "number", ' +
          '"date", and "yesno". Give choice and multi their options; the form already adds a ' +
          '"Something else" choice and an "Anything else?" box, so do not add your own. ' +
          'If the person’s message is a prompt template — it has {{name}} or {{name:type}} ' +
          'placeholders and may end with a ```variables block listing each one’s required, ' +
          'options, min, max, help and default — do not guess the values: ask for every ' +
          'placeholder with this tool, using that block for each question’s type, options and ' +
          'bounds, and carry out the filled-in prompt once their answers arrive.',
        inputSchema: {
          type: 'object',
          properties: {
            intro: {
              type: 'string',
              description: 'A sentence or two saying what you need and why. Optional.',
            },
            questions: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_ASKED_QUESTIONS,
              description: 'The questions, in the order they should appear.',
              items: {
                type: 'object',
                properties: {
                  question: { type: 'string', description: 'The question, one sentence.' },
                  type: {
                    type: 'string',
                    enum: ['text', 'longtext', 'choice', 'multi', 'number', 'date', 'yesno'],
                    description: 'What kind of answer. Default text.',
                  },
                  options: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'For choice and multi: the options to offer.',
                  },
                  required: {
                    type: 'boolean',
                    description: 'The form cannot be sent without an answer. Default false.',
                  },
                  help: { type: 'string', description: 'A line under the control: units, format.' },
                  context: {
                    type: 'string',
                    description:
                      'What the person needs to know to answer, shown under the question.',
                  },
                  min: { type: 'number', description: 'For number: the lowest allowed.' },
                  max: { type: 'number', description: 'For number: the highest allowed.' },
                },
                required: ['question'],
              },
            },
          },
          required: ['questions'],
        },
      },
      readOnly: true,
      async execute(input) {
        const parsed = parseAskFormRequest(input);
        if (!parsed.ok) return errorResult(parsed.message);
        const count = parsed.request.form.filter((node) => node.kind === 'field').length - 1;
        return textResult(
          `Asked the person ${count === 1 ? 'a question' : `${count} questions`} in a form in the ` +
            'chat. Their answers will arrive as their next message. Stop here: do not guess the ' +
            'answers or continue until they do.',
          { [END_TURN_META]: true }
        );
      },
    },
  ];
}
