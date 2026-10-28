import { describe, expect, it } from 'vitest';

import { describeEmbeddingMismatch, embeddingWarnings } from '../project-embedding.js';

const configured = { model: 'BAAI/bge-base-en-v1.5', dimensions: 768 };
const project = { projectId: 'proj_cursordiff', name: 'cursordiff-orchestrator' };

describe('describeEmbeddingMismatch', () => {
  it('reports nothing when model and dimensions match', () => {
    const stamped = { ...project, embeddingModel: 'BAAI/bge-base-en-v1.5', embeddingDimensions: 768 };

    expect(describeEmbeddingMismatch(stamped, configured)).toBeNull();
  });

  it('names both dimensions and the fix when the dimensions differ', () => {
    const stamped = { ...project, embeddingModel: 'codesage/codesage-base-v2', embeddingDimensions: 1024 };

    expect(describeEmbeddingMismatch(stamped, configured)).toBe(
      "Project 'cursordiff-orchestrator' (proj_cursordiff) was embedded with codesage/codesage-base-v2 (1024 dimensions), " +
        'but this server is configured for BAAI/bge-base-en-v1.5 (768 dimensions). ' +
        'Its vectors are not comparable with query vectors, so vector search can return nothing or misranked results. ' +
        'Re-parse the project with the configured model (parse_typescript_project).',
    );
  });

  it('reports a model that differs at the same dimensions', () => {
    const stamped = { ...project, embeddingModel: 'sentence-transformers/all-mpnet-base-v2', embeddingDimensions: 768 };

    expect(describeEmbeddingMismatch(stamped, configured)).toContain(
      'embedded with sentence-transformers/all-mpnet-base-v2 (768 dimensions), but this server is configured for BAAI/bge-base-en-v1.5 (768 dimensions)',
    );
  });

  it('compares only dimensions when the model is unknown', () => {
    const sameSize = { ...project, embeddingModel: null, embeddingDimensions: 768 };
    const otherSize = { ...project, embeddingModel: null, embeddingDimensions: 1024 };

    expect(describeEmbeddingMismatch(sameSize, configured)).toBeNull();
    expect(describeEmbeddingMismatch(otherSize, configured)).toContain('an unknown model (1024 dimensions)');
  });

  it('reports nothing for a project that was never stamped', () => {
    expect(
      describeEmbeddingMismatch({ ...project, embeddingModel: null, embeddingDimensions: null }, configured),
    ).toBeNull();
    expect(describeEmbeddingMismatch(project, configured)).toBeNull();
  });
});

describe('embeddingWarnings', () => {
  it('keeps one warning per mismatched project', () => {
    const projects = [
      { projectId: 'proj_ok', name: 'ok', embeddingModel: 'BAAI/bge-base-en-v1.5', embeddingDimensions: 768 },
      { projectId: 'proj_old', name: 'old', embeddingModel: null, embeddingDimensions: 1024 },
    ];

    const warnings = embeddingWarnings(projects, configured);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Project 'old' (proj_old)");
  });
});
