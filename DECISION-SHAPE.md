# Shared (:Decision) node shape

Two writers produce `Decision` nodes (label is in PRESERVED_LABELS — survives reparse).
The `kind` property discriminates them; absence of `kind` means a hunk decision
(written before this doc existed).

## Common core (both writers)

| Property | Type | Notes |
|---|---|---|
| `id` | string | Deterministic per writer (see below) — MERGE key, re-writes are idempotent |
| `outcome` | string | `accept` \| `reject` |
| `byUser` | boolean | `true` when a human decided |
| `projectId` | string | Graph project the decision's ABOUT targets live in |
| `ts` / `decidedAt` | number | Epoch ms |

## Writer 1 — cursordiff ingestor (hunk decisions)

`src/ingestors/cursordiff/merge-decision.ts`. `id = <hunkId>:<outcome>:<ts>`.
Extra props: `hunkId`, `filePath`, `sessionId`. Edge: `(:Hunk)-[:RESOLVED_BY]->(:Decision)`.
No `kind` property.

## Writer 2 — cursordiff hub (runtime-attribution lens)

`cursordiff/packages/hub/src/runtime-analysis/decision-writeback.ts` +
`graph-client.ts boltMergeAttributionDecision`. `id = runtime-attribution:<analysisId>:<candidateId>`.
`kind = "runtime-attribution"`. Extra props: `analysisId`, `candidateId`, `deploySha`,
`candidateSha`, `env` (`staging`|`prod`), `unavailableBackends` (string[] — degraded-backend
provenance at decision time), `factorSnapshot` (JSON FactorScore[]). Edges:
`(:Decision)-[:ABOUT]->(:SourceFile)` per changed file (path-suffix match inside the
DEPLOYED repo's projectId), `(:Decision)-[:ABOUT]->(:ToolCall)` best-effort when the
candidate commit traces to a cursordiff run.

## Rules for adding a third writer

Keep the common core verbatim; add a new `kind` value; document it here. Query patterns
that must keep working: `MATCH (d:Decision) WHERE d.kind = "runtime-attribution"` and
kind-absent hunk-decision queries.
