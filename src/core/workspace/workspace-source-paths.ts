/**
 * Maps each workspace package's import specifiers to the source file behind them, as TypeScript `paths`.
 * A package's package.json points at build output; the parser needs the declarations in source,
 * because only source files have graph nodes and the output may not be built at all.
 */

import fs from 'fs/promises';
import path from 'path';

import { ts } from 'ts-morph';

import { WorkspaceDetector, WorkspacePackage } from './workspace-detector.js';

export type SourcePaths = Record<string, string[]>;

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
const BUILT_EXTENSION = /(\.d\.[cm]?ts|\.[cm]?js|\.jsx)$/;
const DEFAULT_ENTRIES = ['src/index.ts', 'src/index.tsx', 'index.ts', 'index.tsx'];
// Conditions in the order a TypeScript consumer of the package would take them
const EXPORT_CONDITIONS = ['types', 'import', 'require', 'default'];

interface PackageManifest {
  source?: unknown;
  types?: unknown;
  typings?: unknown;
  main?: unknown;
  exports?: unknown;
}

interface BuildLayout {
  outDir?: string;
  rootDir?: string;
}

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const firstExisting = async (candidates: string[]): Promise<string | undefined> => {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readManifest = async (packagePath: string): Promise<PackageManifest | undefined> => {
  try {
    const manifest: unknown = JSON.parse(await fs.readFile(path.join(packagePath, 'package.json'), 'utf-8'));
    return isRecord(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
};

const readBuildLayout = (tsConfigPath: string | null): BuildLayout => {
  if (!tsConfigPath) return {};
  const { config } = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  if (!config) return {};
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(tsConfigPath));
  return { outDir: options.outDir, rootDir: options.rootDir };
};

/** The file one `exports` target names: a string, or the first condition a TypeScript consumer would match. */
const exportTarget = (target: unknown): string | undefined => {
  if (typeof target === 'string') return target;
  if (!isRecord(target)) return undefined;
  for (const condition of EXPORT_CONDITIONS) {
    const file = exportTarget(target[condition]);
    if (file) return file;
  }
  return undefined;
};

/** Subpath ('.' for the package itself) to the file package.json publishes for it, when it names one. */
const publishedEntries = (manifest: PackageManifest): Map<string, string | undefined> => {
  const main = [manifest.types, manifest.typings, manifest.main].find((entry) => typeof entry === 'string');
  const entries = new Map<string, string | undefined>([['.', typeof main === 'string' ? main : undefined]]);

  const exportsField = manifest.exports;
  const targets: Array<[string, unknown]> =
    isRecord(exportsField) && Object.keys(exportsField).every((key) => key.startsWith('.'))
      ? Object.entries(exportsField)
      : [['.', exportsField]];
  for (const [subpath, target] of targets) {
    const file = exportTarget(target);
    // Pattern subpaths ("./*") name no single file
    if (file && !subpath.includes('*') && !file.includes('*')) entries.set(subpath, file);
  }
  return entries;
};

/** Source candidates for a published file: itself when it is source, else its counterpart under the source root. */
const sourceCandidates = (packagePath: string, publishedFile: string, layout: BuildLayout): string[] => {
  const published = path.resolve(packagePath, publishedFile);
  if (!BUILT_EXTENSION.test(published)) return [published];

  const withoutExtension = published.replace(BUILT_EXTENSION, '');
  const outDir = layout.outDir ?? path.join(packagePath, 'dist');
  const rootDirs = layout.rootDir ? [layout.rootDir] : [path.join(packagePath, 'src'), packagePath];
  const relativeToOutDir = path.relative(outDir, withoutExtension);
  const sourceStems = relativeToOutDir.startsWith('..')
    ? [withoutExtension]
    : rootDirs.map((rootDir) => path.join(rootDir, relativeToOutDir));
  return sourceStems.flatMap((stem) => SOURCE_EXTENSIONS.map((extension) => stem + extension));
};

const packageSourcePaths = async (workspacePackage: WorkspacePackage): Promise<SourcePaths> => {
  const manifest = await readManifest(workspacePackage.path);
  if (!manifest) return {};
  const layout = readBuildLayout(workspacePackage.tsConfigPath);
  const paths: SourcePaths = {};

  for (const [subpath, publishedFile] of publishedEntries(manifest)) {
    const declared = subpath === '.' && typeof manifest.source === 'string' ? [manifest.source] : [];
    const fallbacks = subpath === '.' ? DEFAULT_ENTRIES : [];
    const source = await firstExisting([
      ...declared.map((file) => path.resolve(workspacePackage.path, file)),
      ...(publishedFile ? sourceCandidates(workspacePackage.path, publishedFile, layout) : []),
      ...fallbacks.map((file) => path.join(workspacePackage.path, file)),
    ]);
    if (source && SOURCE_EXTENSIONS.some((extension) => source.endsWith(extension)) && !source.endsWith('.d.ts')) {
      paths[path.posix.join(workspacePackage.name, subpath)] = [source];
    }
  }
  return paths;
};

export const resolveWorkspaceSourcePaths = async (packages: WorkspacePackage[]): Promise<SourcePaths> => {
  const perPackage = await Promise.all(packages.map(packageSourcePaths));
  return Object.assign({}, ...perPackage);
};

/** Source paths for the workspace rooted at `rootPath`; empty for a single-package project. */
export const detectWorkspaceSourcePaths = async (rootPath: string): Promise<SourcePaths> => {
  const workspace = await new WorkspaceDetector().detect(rootPath);
  return workspace.type === 'single' ? {} : resolveWorkspaceSourcePaths(workspace.packages);
};
