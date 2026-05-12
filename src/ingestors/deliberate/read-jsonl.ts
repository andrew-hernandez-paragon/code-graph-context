import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface DeliberationRow {
  type: 'deliberation-start' | 'deliberation-complete' | 'deliberation-aborted';
  id: string;
  topic: string;
  projectIds: string[];
  mode: 'one-shot' | 'rounds';
  status: 'in-progress' | 'completed' | 'aborted';
  aboutNodeIds?: string[];
  triggeredBy?: string;
  sessionId?: string;
  ts?: number;
  iso?: string;
}

export interface PositionRow {
  type: 'position-start' | 'position-complete';
  id: string;
  deliberationId: string;
  role: string;
  content: string;
  claims: string[];
  evidence: string[];
  counterArgs: string[];
  status: 'asserted' | 'abstained';
  agentId?: string;
  ts?: number;
  iso?: string;
}

export interface VerdictRow {
  type: 'verdict';
  id: string;
  deliberationId: string;
  verdict: 'FOLLOW' | 'ITERATE' | 'ALTERNATIVE' | 'NEED-MORE-INPUT';
  rationale: string;
  recordedIn?: string;
  agentId?: string;
  ts?: number;
  iso?: string;
}

export type DeliberateEventRow = DeliberationRow | PositionRow | VerdictRow;

const readJsonl = <T>(path: string): T[] => {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf-8');
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // tolerate malformed lines — JSONL is best-effort
    }
  }
  return out;
};

export interface DeliberateJsonls {
  events: DeliberateEventRow[];
}

/**
 * Read deliberation.jsonl from a data directory.
 * Missing file is treated as empty — the ingestor is idempotent.
 */
export const readDeliberateJsonls = (dataDir: string): DeliberateJsonls => ({
  events: readJsonl<DeliberateEventRow>(join(dataDir, 'deliberation.jsonl')),
});
