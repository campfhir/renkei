import type { OrgDay, UtilizationDay } from './types';

export function emptyDay(day: string): OrgDay {
  return {
    day,
    chatInputTokens: 0,
    chatOutputTokens: 0,
    chatProjectInputTokens: 0,
    chatProjectOutputTokens: 0,
    codeProjectInputTokens: 0,
    codeProjectOutputTokens: 0,
    agentInputTokens: 0,
    agentOutputTokens: 0,
    imageInputTokens: 0,
    imageOutputTokens: 0,
    images: 0,
    imageBytes: 0,
    documentInputTokens: 0,
    documentOutputTokens: 0,
    runs: 0,
    failures: 0,
    toolCalls: 0,
    toolErrors: 0,
  };
}

export function emptyUtilizationDay(day: string): UtilizationDay {
  return {
    day,
    inputTokens: 0,
    outputTokens: 0,
    runs: 0,
    failures: 0,
    toolCalls: 0,
    toolErrors: 0,
  };
}

/** Add one chat bucket's tokens ('chat' | 'chat_project' | 'code') to a day. */
export function foldChatBucket(point: OrgDay, bucket: string, input: number, output: number) {
  if (bucket === 'chat') {
    point.chatInputTokens += input;
    point.chatOutputTokens += output;
  } else if (bucket === 'chat_project') {
    point.chatProjectInputTokens += input;
    point.chatProjectOutputTokens += output;
  } else {
    point.codeProjectInputTokens += input;
    point.codeProjectOutputTokens += output;
  }
}
