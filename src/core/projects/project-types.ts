import type { ParseStatus, ProjectKind } from './project-kinds.js';

export interface Project {
  projectId: string;
  name: string;
  kind: ProjectKind;
  path: string | null;
  description: string | null;
  status: ParseStatus | null;
  nodeCount: number | null;
  edgeCount: number | null;
  /** The model and vector size that embedded a codebase; null until stamped, or when unknown. */
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  updatedAt: string | null;
}

export interface ProjectSummary extends Project {
  memory: { liveNotes: number; bookmarks: number; lastSavedAt: string | null };
}

export interface ProjectCreation {
  project: Project;
  created: boolean;
}
