import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface RouterRow {
  session_id: string;
  prev_model?: string;
  picked?: string;
  switched?: boolean;
  reason?: string;
  ts?: number;
  iso?: string;
  cwd?: string;
}

export interface LineageRow {
  tool_call_id: string;
  session_id: string;
  path: string;
  old_hash: string;
  new_hash: string;
  old_len?: number;
  new_len?: number;
  hunk_id: string;
  tool_name?: string;
  model?: string;
  kind?: string;
  duration_ms?: number;
  success?: boolean;
  ts?: number;
  iso?: string;
}

export interface DecisionRow {
  hunk_id: string;
  file_path: string;
  outcome: 'accept' | 'reject' | 'implicit_reject' | 'abandoned';
  session_id?: string;
  byUser: boolean;
  ts?: number;
  iso?: string;
}

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

export interface CursordiffJsonls {
  router: RouterRow[];
  lineage: LineageRow[];
  decisions: DecisionRow[];
}

/**
 * Read all three cursordiff JSONL files from a data directory.
 * Missing files are treated as empty — the ingestor is idempotent.
 */
export const readCursordiffJsonls = (dataDir: string): CursordiffJsonls => ({
  router: readJsonl<RouterRow>(join(dataDir, 'router.jsonl')),
  lineage: readJsonl<LineageRow>(join(dataDir, 'lineage.jsonl')),
  decisions: readJsonl<DecisionRow>(join(dataDir, 'decisions.jsonl')),
});
