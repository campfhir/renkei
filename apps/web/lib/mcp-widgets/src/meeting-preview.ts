/**
 * Meeting preview card (Zoom).
 *
 * Same shape as the WebEx card: no server-side draft exists, the preview tool
 * only normalized the request, and Create runs the app-only
 * zoom_create_meeting_confirm with the card's current values. Topic and
 * agenda are editable; the start time is shown as given (editing ISO-8601 by
 * hand in a card is a worse experience than asking the model to reschedule).
 */

import { WidgetBridge, resultText, type ToolResult } from './bridge';
import {
  cardActions,
  el,
  injectStyle,
  inputField,
  readonlyField,
  recallDone,
  rememberDone,
  renderDone,
  str,
  textField,
  type DoneState,
} from './ui';

function render(bridge: WidgetBridge, result: ToolResult): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.textContent = '';

  const preview =
    typeof result.structuredContent === 'object' && result.structuredContent !== null
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (result.structuredContent as Record<string, unknown>)
      : {};
  const startTime = str(preview.startTime);
  const duration = typeof preview.durationMinutes === 'number' ? preview.durationMinutes : 0;

  const card = el('div', 'card');
  if (result.isError || !startTime || !duration) {
    card.append(
      el('div', 'card-title', 'Zoom meeting'),
      el('div', 'status error', resultText(result) || 'The meeting could not be prepared.')
    );
    root.append(card);
    return;
  }

  const timezone = str(preview.timezone);
  const stateKey = `renkei-zoom:${str(preview.topic)}:${startTime}`;
  const remembered = recallDone(stateKey);
  if (remembered) {
    renderDone(root, remembered);
    return;
  }
  const finishDone = (state: DoneState) => {
    rememberDone(stateKey, state);
    renderDone(root, state);
  };

  card.append(
    el('div', 'card-title', 'Schedule Zoom meeting'),
    el('div', 'card-subtitle', 'On your calendar — nothing is created until you confirm.')
  );
  const topic = inputField('Topic', str(preview.topic));
  card.append(topic.field);
  card.append(
    readonlyField('When', `${startTime}${timezone ? ` (${timezone})` : ''} — ${duration} min`)
  );
  const agenda = textField('Agenda', str(preview.agenda));
  card.append(agenda.field);

  const cancelButton = el('button', undefined, 'Cancel');
  const createButton = el('button', 'primary', 'Create');
  const footer = cardActions([cancelButton, createButton]);
  card.append(footer.actions);
  root.append(card);

  footer.run(createButton, async () => {
    const created = await bridge.callTool('zoom_create_meeting_confirm', {
      topic: topic.input.value.trim() || str(preview.topic),
      startTime,
      durationMinutes: duration,
      ...(timezone ? { timezone } : {}),
      ...(agenda.input.value.trim() ? { agenda: agenda.input.value.trim() } : {}),
    });
    if (created.isError) throw new Error(resultText(created) || 'Create failed');
    finishDone({
      icon: 'sent',
      headline: 'Meeting created',
      detail: `“${topic.input.value.trim()}” — ${startTime}`,
    });
    bridge.updateModelContext(
      `The user confirmed the Zoom meeting preview; "${topic.input.value.trim()}" was scheduled for ${startTime}.`
    );
  });

  footer.run(cancelButton, async () => {
    finishDone({ icon: 'cancelled', headline: 'Cancelled', detail: 'Nothing was created.' });
    bridge.updateModelContext(
      'The user cancelled the Zoom meeting from the preview card. Nothing was created.'
    );
  });
}

const bridge = new WidgetBridge('renkei-meeting-preview');
injectStyle();
bridge.toolResult((result) => render(bridge, result));
void bridge.connect();
