/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The sample analyzer's server-side honesty checks: a model proposal only
 * survives if it would actually strip something (verbatim match under the
 * cleaner's whitespace-flexible semantics), never comes from the legal
 * footer (already stripped wholesale), and never duplicates the library.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let modelReply = '';
jest.mock('@renkei/agent-llm', () => ({
  resolveAgentLlm: jest.fn(async () => ({
    ok: true,
    val: {
      provider: {
        complete: async () => ({
          ok: true,
          val: {
            content: [{ type: 'text', text: modelReply }],
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 10 },
          },
        }),
      },
      maxOutputTokens: 512,
    },
  })),
}));

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { suggestBannerPhrasesFromSample } from './suggest-from-sample';

const dbWithBanners = (phrases: string[]) =>
  ({
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          where: () => ({ execute: async () => phrases.map((phrase) => ({ phrase })) }),
        }),
      }),
    }),
  }) as unknown as Kysely<DB>;

const SAMPLE = [
  'Hi team, the deploy is done.',
  '',
  'Scott Eremia-Roden',
  '2171 Junipero Serra Blvd',
  'Follow NEMS: Facebook | WeChat | Instagram | LinkedIn',
  '',
  'CONFIDENTIALITY NOTICE:',
  'This email and any files transmitted with it are the property of North East',
  'Medical Services, are confidential, and intended only for the named recipient.',
].join('\n');

const reply = (phrases: { phrase: string; rationale?: string }[]) =>
  JSON.stringify({ rules: [], phrases: phrases.map((p) => ({ rationale: 'org-wide', ...p })) });

describe('suggestBannerPhrasesFromSample', () => {
  it('keeps verbatim matches, drops paraphrases and footer fragments', async () => {
    modelReply = reply([
      // Verbatim (line-wrap flexible matching) — survives.
      { phrase: 'Follow NEMS: Facebook | WeChat | Instagram | LinkedIn' },
      // Paraphrased — the cleaner would never match it; dropped.
      { phrase: 'Follow North East Medical Services on social media' },
      // From inside the legal notice — that region is stripped wholesale
      // already, and the analyzer never even shows it to the model; dropped.
      { phrase: 'are the property of North East Medical Services' },
      // Too short to be safe as strip-anywhere boilerplate; dropped.
      { phrase: 'Follow NEMS: Facebook' },
    ]);

    const result = await suggestBannerPhrasesFromSample(dbWithBanners([]), 'tenant-1', SAMPLE);
    if ('error' in result) throw new Error(result.error);
    expect(result.phrases.map((p) => p.phrase)).toEqual([
      'Follow NEMS: Facebook | WeChat | Instagram | LinkedIn',
    ]);
    // The notice is reported as handled rather than proposed.
    expect(result.alreadyCovered.join(' ')).toContain('footer detector');
  });

  it('drops phrases already in the library', async () => {
    modelReply = reply([{ phrase: 'Follow NEMS: Facebook | WeChat | Instagram | LinkedIn' }]);
    const result = await suggestBannerPhrasesFromSample(
      dbWithBanners(['Follow NEMS: Facebook | WeChat | Instagram | LinkedIn']),
      'tenant-1',
      SAMPLE
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.phrases).toHaveLength(0);
    // ...and the coverage note says the library already handles it.
    expect(result.alreadyCovered.join(' ')).toContain('existing library entry');
  });

  it('refuses a sample too short to learn from', async () => {
    const result = await suggestBannerPhrasesFromSample(dbWithBanners([]), 'tenant-1', 'hi');
    expect('error' in result).toBe(true);
  });
});
