/**
 * ADR writer helper for deliberation verdicts.
 *
 * Writes a Keep-a-Changelog-style ADR only for ALTERNATIVE or NEED-MORE-INPUT
 * verdicts. FOLLOW verdicts get a session note instead (per proposal 0004 —
 * keeps decisions/ signal-dense).
 *
 * ADR format follows ~/develop/CLAUDE.md § Decisions template.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve as resolvePath } from 'path';

export interface DeliberationSummary {
  id: string;
  topic: string;
  projectIds: string[];
  mode: 'one-shot' | 'rounds';
  sessionId?: string;
}

export interface VerdictSummary {
  id: string;
  deliberationId: string;
  verdict: 'FOLLOW' | 'ITERATE' | 'ALTERNATIVE' | 'NEED-MORE-INPUT';
  rationale: string;
  agentId?: string;
}

export interface PositionSummary {
  role: string;
  status: 'asserted' | 'abstained';
  content: string;
  claims: string[];
  evidence: string[];
  counterArgs: string[];
}

export interface WriteAdrResult {
  written: boolean;
  path?: string;
  reason?: string;
}

/**
 * Slugify a topic string for use in filenames.
 */
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s]+/g, '-')
    .slice(0, 60);

/**
 * Determine the next ADR sequence number by scanning the decisions directory.
 */
const nextSequenceNumber = (decisionsDir: string): string => {
  if (!existsSync(decisionsDir)) return '0001';
  const entries = readdirSync(decisionsDir).filter((f) => /^\d{4}-/.test(f));
  if (entries.length === 0) return '0001';
  const maxNum = entries.reduce((max, f) => {
    const n = parseInt(f.slice(0, 4), 10);
    return n > max ? n : max;
  }, 0);
  return String(maxNum + 1).padStart(4, '0');
};

/**
 * Build ADR file content from deliberation + verdict + positions.
 */
const buildAdrContent = (
  deliberation: DeliberationSummary,
  verdict: VerdictSummary,
  positions: PositionSummary[],
  seqNum: string,
  date: string,
): string => {
  const title = `${seqNum} — ${deliberation.topic}`;
  const status = verdict.verdict === 'ALTERNATIVE' ? 'proposed' : 'needs-more-input';

  const positionBlocks = positions
    .map((p) => {
      const lines: string[] = [`### ${p.role} (${p.status})`];
      if (p.status === 'abstained') {
        lines.push('ABSTAIN-NO-UNIQUE-POSITION');
        return lines.join('\n');
      }
      lines.push('');
      if (p.content) lines.push(p.content);
      if (p.claims.length > 0) {
        lines.push('');
        lines.push('**Claims:**');
        p.claims.forEach((c) => lines.push(`- ${c}`));
      }
      if (p.evidence.length > 0) {
        lines.push('');
        lines.push('**Evidence:**');
        p.evidence.forEach((e) => lines.push(`- ${e}`));
      }
      if (p.counterArgs.length > 0) {
        lines.push('');
        lines.push('**Counter-arguments:**');
        p.counterArgs.forEach((c) => lines.push(`- ${c}`));
      }
      return lines.join('\n');
    })
    .join('\n\n');

  return [
    `# ${title}`,
    '',
    `Status: ${status}`,
    `Date: ${date}`,
    `Deliberation ID: ${deliberation.id}`,
    `Projects: ${deliberation.projectIds.join(', ') || '(none)'}`,
    '',
    '## Context',
    '',
    deliberation.topic,
    '',
    '## Decision',
    '',
    verdict.verdict,
    '',
    '## Rationale',
    '',
    verdict.rationale,
    '',
    '## Panel Positions',
    '',
    positionBlocks,
    '',
    '## Consequences',
    '',
    '(To be filled after implementation.)',
    '',
    '## Alternatives considered',
    '',
    '(See panel positions above.)',
    '',
  ].join('\n');
};

/**
 * Write an ADR for ALTERNATIVE or NEED-MORE-INPUT verdicts.
 * For FOLLOW verdicts, returns { written: false, reason: 'follow-verdict' }
 * since those get a session note instead (keeps decisions/ signal-dense).
 *
 * @param deliberation - Deliberation summary
 * @param verdict - Verdict summary
 * @param positions - All panel positions for this deliberation
 * @param decisionsDir - Directory to write ADRs (default: ~/develop/decisions)
 * @returns WriteAdrResult
 */
export const writeAdrIfNeeded = (
  deliberation: DeliberationSummary,
  verdict: VerdictSummary,
  positions: PositionSummary[] = [],
  decisionsDir = join(homedir(), 'develop/decisions'),
): WriteAdrResult => {
  if (verdict.verdict === 'FOLLOW') {
    return { written: false, reason: 'follow-verdict' };
  }

  if (verdict.verdict === 'ITERATE') {
    return { written: false, reason: 'iterate-verdict' };
  }

  // ALTERNATIVE or NEED-MORE-INPUT — write the ADR
  const resolvedDir = resolvePath(decisionsDir);

  if (!existsSync(resolvedDir)) {
    mkdirSync(resolvedDir, { recursive: true });
  }

  const seqNum = nextSequenceNumber(resolvedDir);
  const slug = slugify(deliberation.topic);
  const filename = `${seqNum}-${slug}.md`;
  const filePath = join(resolvedDir, filename);
  const date = new Date().toISOString().split('T')[0];

  const content = buildAdrContent(deliberation, verdict, positions, seqNum, date);
  writeFileSync(filePath, content, 'utf-8');

  return { written: true, path: filePath };
};
