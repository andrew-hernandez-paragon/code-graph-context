import { getEmbeddingDimensions, getEmbeddingModel } from '../embeddings/embedding-config.js';

import type { Project } from './project-types.js';

export interface EmbeddingConfiguration {
  model: string;
  dimensions: number;
}

type StampedProject = Pick<Project, 'name' | 'projectId'> &
  Partial<Pick<Project, 'embeddingModel' | 'embeddingDimensions'>>;

const describeEmbedding = (model: string | null, dimensions: number | null): string =>
  `${model ?? 'an unknown model'} (${dimensions ?? 'unknown'} dimensions)`;

/**
 * Why vector search over this project cannot be trusted, or null when its stamp agrees with the
 * configuration. Dimensions are always compared; models only when both are known.
 */
export const describeEmbeddingMismatch = (
  project: StampedProject,
  configured: EmbeddingConfiguration,
): string | null => {
  const model = project.embeddingModel ?? null;
  const dimensions = project.embeddingDimensions ?? null;
  if (dimensions === null) return null;

  const dimensionsDiffer = dimensions !== configured.dimensions;
  const modelsDiffer = model !== null && model !== configured.model;
  if (!dimensionsDiffer && !modelsDiffer) return null;

  return (
    `Project '${project.name}' (${project.projectId}) was embedded with ${describeEmbedding(model, dimensions)}, ` +
    `but this server is configured for ${describeEmbedding(configured.model, configured.dimensions)}. ` +
    'Its vectors are not comparable with query vectors, so vector search can return nothing or misranked results. ' +
    'Re-parse the project with the configured model (parse_typescript_project).'
  );
};

/** The warnings for every project whose embeddings differ from the configured model, for a tool to attach to its response. */
export const embeddingWarnings = (
  projects: readonly StampedProject[],
  configured: EmbeddingConfiguration = { model: getEmbeddingModel(), dimensions: getEmbeddingDimensions() },
): string[] =>
  projects.flatMap((project) => {
    const warning = describeEmbeddingMismatch(project, configured);
    return warning === null ? [] : [warning];
  });
