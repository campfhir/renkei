import { getTurnChannel, openTurnChannel, resetTurnChannels } from './turn-events';
import type { ChatStreamEvent } from './stream-events';

const ping = (n: number): ChatStreamEvent => ({
  type: 'text_delta',
  messageId: 'm',
  index: 0,
  text: String(n),
});

beforeEach(() => resetTurnChannels());

describe('turn channel', () => {
  it('numbers events, replays from a sequence, and follows live', () => {
    const channel = openTurnChannel('t');
    channel.emit(ping(1));
    channel.emit(ping(2));
    const seen: number[] = [];
    const unsubscribe = channel.subscribe(1, ({ seq }) => seen.push(seq));
    expect(unsubscribe).not.toBeNull();
    channel.emit(ping(3));
    expect(seen).toEqual([2, 3]);
    unsubscribe?.();
    channel.emit(ping(4));
    expect(seen).toEqual([2, 3]);
    expect(channel.lastSeq).toBe(4);
    expect(getTurnChannel('t')).toBe(channel);
  });

  it('refuses a replay the ring no longer holds', () => {
    const channel = openTurnChannel('t');
    for (let i = 0; i < 2_105; i += 1) channel.emit(ping(i));
    expect(channel.subscribe(50, () => {})).toBeNull();
    expect(channel.subscribe(2_000, () => {})).not.toBeNull();
  });

  it('delivers a cancel to listeners, including late ones', () => {
    const channel = openTurnChannel('t');
    let count = 0;
    channel.onCancel(() => (count += 1));
    channel.requestCancel();
    channel.requestCancel();
    channel.onCancel(() => (count += 1));
    expect(count).toBe(2);
    expect(channel.cancelRequested).toBe(true);
  });

  it('drops nothing on close but stops accepting events', () => {
    const channel = openTurnChannel('t');
    channel.emit(ping(1));
    channel.close();
    channel.emit(ping(2));
    const seen: number[] = [];
    channel.subscribe(0, ({ seq }) => seen.push(seq));
    expect(seen).toEqual([1]);
    expect(channel.closed).toBe(true);
  });
});
