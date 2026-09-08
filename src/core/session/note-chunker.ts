/**
 * note-chunker.ts — split a long SessionNote's content into searchable chunks
 * linked back to the parent (GraphRAG parent-child pattern). The chunks get
 * embedded individually so vector recall surfaces specific facts buried in
 * long architectural notes; renderers always retrieve and display the parent.
 *
 * Boundary semantics:
 *   • Paragraph splits (blank line) are the primary boundary
 *   • Markdown fenced code blocks (```…```) are kept atomic — never split
 *     across the fence
 *   • Sentence-level splits are the fallback when a single paragraph exceeds
 *     maxTokens (typical case: a long unparagraphed prose block)
 *   • Adjacent small chunks are merged up to maxTokens to avoid creating
 *     fragments below minTokens
 *   • Notes ≤ chunkThresholdTokens are not chunked at all — they're already
 *     small enough that the parent embedding has high recall precision on its own
 *
 * Token estimation is character-based (ceil(chars / 4)). Cheap and stable
 * across models; precision-suitable for chunk-size budgeting (not for actual
 * billing). Acceptable error band: ~10-15% for English prose, ~25% for
 * code-heavy content.
 */

const DEFAULT_CHUNK_THRESHOLD_TOKENS = 600;
const DEFAULT_MIN_CHUNK_TOKENS = 80;
const DEFAULT_MAX_CHUNK_TOKENS = 600;

export interface ChunkerOptions {
  chunkThresholdTokens?: number;
  minChunkTokens?: number;
  maxChunkTokens?: number;
}

export interface Chunk {
  index: number;
  content: string;
  estimatedTokens: number;
}

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Split content into paragraphs, treating fenced code blocks as atomic units
 * (a code fence may span many blank lines internally; we keep it whole).
 */
export function splitIntoParagraphs(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flushBuffer = (): void => {
    if (buffer.length === 0) return;
    // Trim trailing empty lines off the buffer, but only when we're at a
    // legitimate paragraph boundary (outside any code fence).
    while (buffer.length > 0 && buffer[buffer.length - 1] === '') {
      buffer.pop();
    }
    if (buffer.length === 0) return;
    paragraphs.push(buffer.join('\n'));
    buffer = [];
  };

  for (const line of lines) {
    const isFenceMarker = /^\s*```/.test(line);
    if (isFenceMarker) {
      // Either opening or closing a fence — include the line in the current
      // paragraph but toggle state.
      buffer.push(line);
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.trim() === '') {
      flushBuffer();
      continue;
    }
    buffer.push(line);
  }
  flushBuffer();
  return paragraphs;
}

/**
 * Split a single (over-large) paragraph into sentence-bounded pieces, each
 * ≤ maxTokens. Uses a simple ". " / "! " / "? " regex split — good enough
 * for English prose; falls back to hard-cut if a single sentence is itself
 * over-large.
 */
export function splitIntoSentences(paragraph: string, maxTokens: number): string[] {
  if (estimateTokens(paragraph) <= maxTokens) return [paragraph];

  // Split on sentence terminators but preserve them. Lookbehind keeps the
  // ". " etc. on the trailing side of the previous sentence.
  const sentences = paragraph
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    const candidate = buf ? `${buf} ${s}` : s;
    if (estimateTokens(candidate) <= maxTokens) {
      buf = candidate;
    } else {
      if (buf) out.push(buf);
      if (estimateTokens(s) <= maxTokens) {
        buf = s;
      } else {
        // Hard-cut a runaway sentence at maxTokens * CHARS_PER_TOKEN chars.
        const maxChars = maxTokens * CHARS_PER_TOKEN;
        for (let i = 0; i < s.length; i += maxChars) {
          const piece = s.slice(i, i + maxChars);
          out.push(piece);
        }
        buf = '';
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Main entry. Returns [] when content is below the chunk threshold — caller
 * should not create chunk nodes for short notes (they're already precise
 * enough at the parent level).
 */
export function chunkNoteContent(content: string, opts: ChunkerOptions = {}): Chunk[] {
  const threshold = opts.chunkThresholdTokens ?? DEFAULT_CHUNK_THRESHOLD_TOKENS;
  const minTokens = opts.minChunkTokens ?? DEFAULT_MIN_CHUNK_TOKENS;
  const maxTokens = opts.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS;

  if (!content || estimateTokens(content) <= threshold) return [];

  const paragraphs = splitIntoParagraphs(content);
  const intermediate: string[] = [];
  let buf = '';

  const pushBuf = (): void => {
    if (buf.length > 0) {
      intermediate.push(buf);
      buf = '';
    }
  };

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    if (paraTokens > maxTokens) {
      // Single paragraph is itself too large — flush, then split it.
      pushBuf();
      const subs = splitIntoSentences(para, maxTokens);
      for (const sub of subs) intermediate.push(sub);
      continue;
    }

    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (estimateTokens(candidate) <= maxTokens) {
      buf = candidate;
    } else {
      pushBuf();
      buf = para;
    }
  }
  pushBuf();

  // Merge small chunks with their predecessor up to maxTokens. We iterate
  // and rebuild rather than mutate-in-place to keep the logic simple.
  const merged: string[] = [];
  for (const piece of intermediate) {
    if (
      merged.length > 0 &&
      estimateTokens(piece) < minTokens &&
      estimateTokens(`${merged[merged.length - 1]}\n\n${piece}`) <= maxTokens
    ) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${piece}`;
    } else {
      merged.push(piece);
    }
  }

  return merged.map((piece, index) => ({
    index,
    content: piece,
    estimatedTokens: estimateTokens(piece),
  }));
}
