/**
 * note-chunker.test.ts — pure unit tests for the chunker. No Neo4j.
 *
 * Covers: threshold-below short-circuit, paragraph-boundary splits,
 * markdown fence preservation, oversized-paragraph sentence fallback,
 * small-chunk merge into predecessor, hard-cut on runaway sentences.
 */

import { describe, expect, it } from 'vitest';

import { chunkNoteContent, estimateTokens, splitIntoParagraphs, splitIntoSentences } from '../note-chunker.js';

const repeat = (s: string, n: number): string => Array.from({ length: n }, () => s).join('');

describe('estimateTokens', () => {
  it('approximates with ceil(chars / 4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('splitIntoParagraphs', () => {
  it('splits on blank-line boundaries', () => {
    const text = 'para one\nline 2\n\npara two\n\npara three';
    expect(splitIntoParagraphs(text)).toEqual(['para one\nline 2', 'para two', 'para three']);
  });

  it('keeps fenced code blocks atomic even when they contain blank lines', () => {
    const text = [
      'introductory prose',
      '',
      '```typescript',
      'function foo() {',
      '',
      '  return 42;',
      '',
      '}',
      '```',
      '',
      'closing prose',
    ].join('\n');

    const paragraphs = splitIntoParagraphs(text);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toBe('introductory prose');
    expect(paragraphs[1]).toContain('```typescript');
    expect(paragraphs[1]).toContain('return 42');
    expect(paragraphs[1]).toContain('```');
    expect(paragraphs[2]).toBe('closing prose');
  });

  it('handles content with no blank lines as one paragraph', () => {
    const text = 'line one\nline two\nline three';
    expect(splitIntoParagraphs(text)).toEqual([text]);
  });

  it('returns empty array on empty input', () => {
    expect(splitIntoParagraphs('')).toEqual([]);
  });
});

describe('splitIntoSentences', () => {
  it('returns the input unchanged when it fits within maxTokens', () => {
    const para = 'A short paragraph. Two sentences.';
    expect(splitIntoSentences(para, 100)).toEqual([para]);
  });

  it('splits on sentence terminators when needed', () => {
    // Each sentence ~5 tokens; maxTokens = 6 forces a split per sentence.
    const para = 'First sentence here. Second one too. Third lands last.';
    const chunks = splitIntoSentences(para, 6);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  it('hard-cuts a single oversized sentence', () => {
    const sentence = repeat('a', 4000); // 1000 tokens, no punctuation
    const chunks = splitIntoSentences(sentence, 250);
    // Should produce ~4 pieces of 1000 chars each (250 tokens × 4 chars/token).
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.every((c) => estimateTokens(c) <= 250)).toBe(true);
  });
});

describe('chunkNoteContent', () => {
  it('returns no chunks when content is below threshold', () => {
    const short = 'A short note that absolutely fits in one embedding.';
    expect(chunkNoteContent(short)).toEqual([]);
  });

  it('returns no chunks on empty input', () => {
    expect(chunkNoteContent('')).toEqual([]);
  });

  it('chunks long prose by paragraph and stays under maxTokens', () => {
    const para = (n: number): string => `Paragraph ${n}. ${repeat('lorem ipsum dolor sit amet ', 30)}`;
    const content = [para(1), para(2), para(3), para(4), para(5), para(6), para(7), para(8)].join('\n\n');
    const chunks = chunkNoteContent(content, {
      chunkThresholdTokens: 100,
      minChunkTokens: 30,
      maxChunkTokens: 200,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(200);
      expect(chunk.content.length).toBeGreaterThan(0);
    }
    // Index sequence is 0..N-1
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it('preserves a fenced code block within a single chunk', () => {
    const preCode = repeat('Some lead-in prose. ', 100); // ~500 tokens
    const codeBlock = '```typescript\n' + repeat('const foo = 1;\n', 40) + '```';
    const postCode = repeat('Some trailing prose. ', 100);
    const content = `${preCode}\n\n${codeBlock}\n\n${postCode}`;

    const chunks = chunkNoteContent(content, {
      chunkThresholdTokens: 100,
      minChunkTokens: 30,
      maxChunkTokens: 300,
    });
    // The code block must appear, intact, inside exactly one chunk.
    const codeChunks = chunks.filter((c) => c.content.includes('```typescript'));
    expect(codeChunks.length).toBe(1);
    const codeChunk = codeChunks[0];
    expect(codeChunk).toBeDefined();
    expect(codeChunk!.content).toContain('```typescript');
    expect(codeChunk!.content.match(/```/g)?.length).toBe(2); // open + close fence both present
  });

  it('merges undersized final chunks into the predecessor', () => {
    // Three medium paragraphs + one tiny trailing paragraph. The tiny one
    // (below minChunkTokens) should be merged into the previous chunk
    // rather than left as its own chunk.
    const big = repeat('content line. ', 30); // ~120 tokens
    const tiny = 'tiny.'; // ~2 tokens
    const content = [big, big, big, tiny].join('\n\n');
    const chunks = chunkNoteContent(content, {
      chunkThresholdTokens: 50,
      minChunkTokens: 30,
      maxChunkTokens: 200,
    });
    // The tiny line should NOT be a standalone final chunk.
    expect(chunks[chunks.length - 1]!.content).not.toBe(tiny);
    expect(chunks[chunks.length - 1]!.estimatedTokens).toBeGreaterThan(estimateTokens(tiny));
  });

  it('falls back to sentence-splitting when a single paragraph exceeds maxTokens', () => {
    const paraOfSentences = 'Sentence one is here. ' + 'Sentence two is here. ' + repeat('Sentence M is here. ', 50);
    const chunks = chunkNoteContent(paraOfSentences, {
      chunkThresholdTokens: 30,
      minChunkTokens: 20,
      maxChunkTokens: 80,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(80);
    }
  });
});
