/**
 * Shared Utilities
 * Common interfaces, types, and helper functions used across dead code and duplicate code detection tools.
 */

import path from 'path';

// ============================================================================
// Neo4j Result Interfaces
// ============================================================================

/**
 * Base interface for Neo4j query result records.
 * All query-specific interfaces should extend this.
 */
export interface Neo4jRecord {
  [key: string]: unknown;
}

/**
 * Neo4j Integer type - numbers from Neo4j may come as objects with toNumber() method.
 */
export interface Neo4jInteger {
  toNumber: () => number;
}

/**
 * Result from FIND_UNREFERENCED_EXPORTS query
 */
export interface UnreferencedExportResult extends Neo4jRecord {
  nodeId: string;
  name: string;
  coreType: string;
  semanticType: string | null;
  filePath: string;
  lineNumber: number | Neo4jInteger;
  isExported: boolean;
  reason: string;
}

/**
 * Result from FIND_UNCALLED_PRIVATE_METHODS query
 */
export interface UncalledPrivateMethodResult extends Neo4jRecord {
  nodeId: string;
  name: string;
  coreType: string;
  semanticType: string | null;
  filePath: string;
  lineNumber: number | Neo4jInteger;
  visibility: string;
  reason: string;
}

/**
 * Result from FIND_UNREFERENCED_INTERFACES query
 */
export interface UnreferencedInterfaceResult extends Neo4jRecord {
  nodeId: string;
  name: string;
  coreType: string;
  semanticType: string | null;
  filePath: string;
  lineNumber: number | Neo4jInteger;
  reason: string;
}

/**
 * Result from GET_FRAMEWORK_ENTRY_POINTS query
 */
export interface FrameworkEntryPointResult extends Neo4jRecord {
  nodeId: string;
  name: string;
  coreType: string;
  semanticType: string | null;
  filePath: string;
}

/**
 * Result from FIND_STRUCTURAL_DUPLICATES query
 */
export interface StructuralDuplicateResult extends Neo4jRecord {
  nodeId: string;
  name: string;
  coreType: string;
  semanticType: string | null;
  filePath: string;
  lineNumber: number | Neo4jInteger;
  normalizedHash: string;
  sourceCode: string | null;
}

/**
 * Result from FIND_SEMANTIC_DUPLICATES query
 */
export interface SemanticDuplicateResult extends Neo4jRecord {
  nodeId1: string;
  name1: string;
  coreType1: string;
  semanticType1: string | null;
  filePath1: string;
  lineNumber1: number | Neo4jInteger;
  sourceCode1: string | null;
  nodeId2: string;
  name2: string;
  coreType2: string;
  semanticType2: string | null;
  filePath2: string;
  lineNumber2: number | Neo4jInteger;
  sourceCode2: string | null;
  similarity: number | Neo4jInteger;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert Neo4j value to JavaScript number.
 * Handles both regular numbers and Neo4j Integer objects.
 */
export const toNumber = (value: unknown): number => {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    return (value as Neo4jInteger).toNumber();
  }
  return 0;
};

/** As toNumber, but a missing value stays null instead of becoming 0. */
export const toNumberOrNull = (value: unknown): number | null => (value == null ? null : toNumber(value));

/**
 * Check if file path indicates a UI component.
 * Must be in UI component directory AND be a React/Vue component file.
 * Cross-platform: matches both / and \ path separators.
 */
export const isUIComponent = (filePath: string): boolean => {
  const isInUIDir = /[/\\](components[/\\]ui|ui[/\\]components)[/\\]/.test(filePath);
  const isFrontendFile = /\.(tsx|jsx|vue)$/.test(filePath);
  return isInUIDir && isFrontendFile;
};

/**
 * Check if file is in a package directory (monorepo packages).
 * Cross-platform: matches both / and \ path separators.
 */
export const isPackageExport = (filePath: string): boolean => {
  return /[/\\]packages[/\\][^/\\]+[/\\]/.test(filePath);
};

/**
 * Extract monorepo app name from file path.
 * Cross-platform: matches both / and \ path separators.
 */
export const getMonorepoAppName = (filePath: string): string | null => {
  const match = filePath.match(/[/\\](apps|packages)[/\\]([^/\\]+)[/\\]/);
  return match ? match[2] : null;
};

/**
 * Check if file matches exclusion pattern.
 * Supports simple glob patterns starting with *.
 */
export const isExcludedByPattern = (filePath: string, patterns: string[]): boolean => {
  return patterns.some((pattern) => {
    if (pattern.startsWith('*')) {
      return filePath.endsWith(pattern.substring(1));
    }
    return filePath.endsWith(pattern);
  });
};

/**
 * Truncate source code to a maximum length.
 * Useful for limiting response sizes.
 */
export const truncateSourceCode = (
  sourceCode: string | null | undefined,
  maxLength: number = 500,
): string | undefined => {
  if (!sourceCode) return undefined;
  return sourceCode.substring(0, maxLength);
};

/**
 * Get shortened file path (last N segments).
 * Useful for compact display.
 * Cross-platform: uses path.sep for correct separator handling.
 */
export const getShortPath = (filePath: string, segments: number = 2): string => {
  const parts = filePath.split(path.sep);
  return parts.slice(-segments).join(path.sep);
};
