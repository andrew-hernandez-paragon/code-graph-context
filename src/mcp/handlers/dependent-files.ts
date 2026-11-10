/**
 * Dependent Files
 * Finds the unchanged files whose edges into reparsed files cannot be restored by node id.
 */

import { basename, dirname, resolve } from 'path';

import { CoreNodeType, type Neo4jNode } from '../../core/config/schema.js';
import { Neo4jService } from '../../storage/neo4j/neo4j.service.js';

export const NODE_IDS_IN_FILES_QUERY = `
  MATCH (n:GraphNode)
  WHERE n.projectId = $projectId AND n.filePath IN $filePaths
  RETURN n.id AS id
`;

// Narrows on the server: an import that has one of the names among its tokens, or whose specifier ends in
// one of the module names. findDependentFiles makes the exact match.
export const CANDIDATE_IMPORTS_QUERY = `
  MATCH (i:GraphNode)
  WHERE i.projectId = $projectId
    AND i.coreType = $importType
    AND NOT i.filePath IN $excludeFilePaths
    AND (any(token IN apoc.text.split(i.sourceCode, '[^A-Za-z0-9_$]+') WHERE token IN $names)
      OR split(last(split(i.name, '/')), '.')[0] IN $moduleNames)
  RETURN i.filePath AS filePath, i.name AS moduleSpecifier, i.sourceCode AS sourceCode
`;

export const FILES_MENTIONING_QUERY = `
  MATCH (n:GraphNode)
  WHERE n.projectId = $projectId
    AND n.filePath IN $filePaths
    AND any(name IN $names WHERE n.sourceCode CONTAINS name)
  RETURN DISTINCT n.filePath AS filePath
`;

/** The declarations an import can name. A class member is reached through its class instead. */
const IMPORTABLE_TYPES: ReadonlySet<CoreNodeType> = new Set([
  CoreNodeType.CLASS_DECLARATION,
  CoreNodeType.INTERFACE_DECLARATION,
  CoreNodeType.ENUM_DECLARATION,
  CoreNodeType.FUNCTION_DECLARATION,
  CoreNodeType.VARIABLE_DECLARATION,
  CoreNodeType.TYPE_ALIAS,
]);

const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/;
const STRING_LITERAL = /(['"`]).*?\1/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

const withoutExtension = (path: string): string => path.replace(SCRIPT_EXTENSION, '');

/** What an import specifier can resolve to for a file: the file, and its directory when it is an index file. */
const modulePathsOf = (filePath: string): string[] => {
  const modulePath = withoutExtension(filePath);
  return basename(modulePath) === 'index' ? [modulePath, dirname(modulePath)] : [modulePath];
};

const identifiersOf = (importStatement: string): string[] =>
  importStatement.replace(STRING_LITERAL, '').match(IDENTIFIER) ?? [];

const importsAnyModule = (importerPath: string, specifier: string, modulePaths: string[]): boolean => {
  if (specifier.startsWith('.')) {
    return modulePaths.includes(withoutExtension(resolve(dirname(importerPath), specifier)));
  }
  // A path alias or package subpath maps through tsconfig, so match its last segment and let the parser resolve it.
  return modulePaths.some((modulePath) => basename(modulePath) === withoutExtension(basename(specifier)));
};

export const loadNodeIds = async (
  neo4jService: Neo4jService,
  filePaths: string[],
  projectId: string,
): Promise<Set<string>> => {
  const rows = await neo4jService.run(NODE_IDS_IN_FILES_QUERY, { filePaths, projectId });
  return new Set(rows.map((row) => row.id));
};

interface NewDeclarations {
  /** Names an import statement would carry: top-level declarations, and classes that gained a constructor. */
  importedNames: Set<string>;
  /** New members by class. An importer of the class can reference one only if its source mentions the member. */
  memberNamesByClass: Map<string, Set<string>>;
  modulePaths: string[];
}

const classifyNewNodes = (newNodes: Neo4jNode[]): NewDeclarations => {
  const declarations: NewDeclarations = { importedNames: new Set(), memberNamesByClass: new Map(), modulePaths: [] };
  for (const { properties } of newNodes) {
    const { coreType, name, parentClassName } = properties;
    if (coreType === CoreNodeType.SOURCE_FILE) {
      declarations.modulePaths.push(...modulePathsOf(properties.filePath));
    } else if (parentClassName === undefined) {
      if (IMPORTABLE_TYPES.has(coreType)) declarations.importedNames.add(name);
    } else if (coreType === CoreNodeType.CONSTRUCTOR_DECLARATION) {
      // Every file that constructs the class gains a call edge, and none of them mentions "constructor".
      declarations.importedNames.add(parentClassName);
    } else {
      const members = declarations.memberNamesByClass.get(parentClassName) ?? new Set();
      declarations.memberNamesByClass.set(parentClassName, members.add(name));
    }
  }
  return declarations;
};

/**
 * The files outside `excludeFilePaths` that can hold a reference to one of `newNodes`: they import a
 * new declaration by name, import a class and mention its new member, or import a new file.
 * `newNodes` are nodes the graph did not hold before the reparse (a renamed or added declaration, or
 * anything in a new file), so no saved edge points at them and only a parse of the importer finds its edges.
 */
export const findDependentFiles = async (
  neo4jService: Neo4jService,
  newNodes: Neo4jNode[],
  excludeFilePaths: string[],
  projectId: string,
): Promise<string[]> => {
  const { importedNames, memberNamesByClass, modulePaths } = classifyNewNodes(newNodes);
  if (importedNames.size === 0 && memberNamesByClass.size === 0 && modulePaths.length === 0) return [];

  const rows = await neo4jService.run(CANDIDATE_IMPORTS_QUERY, {
    projectId,
    importType: CoreNodeType.IMPORT_DECLARATION,
    excludeFilePaths,
    names: [...importedNames, ...memberNamesByClass.keys()],
    moduleNames: [...new Set(modulePaths.map((modulePath) => basename(modulePath).split('.')[0]))],
  });

  const dependentFiles = new Set<string>();
  const classImporters = new Set<string>();
  const memberNames = new Set<string>();
  for (const row of rows) {
    const identifiers = identifiersOf(row.sourceCode);
    if (
      identifiers.some((identifier) => importedNames.has(identifier)) ||
      importsAnyModule(row.filePath, row.moduleSpecifier, modulePaths)
    ) {
      dependentFiles.add(row.filePath);
    }
    for (const identifier of identifiers) {
      for (const member of memberNamesByClass.get(identifier) ?? []) {
        classImporters.add(row.filePath);
        memberNames.add(member);
      }
    }
  }

  const undecidedFiles = [...classImporters].filter((filePath) => !dependentFiles.has(filePath));
  if (undecidedFiles.length > 0) {
    const mentioning = await neo4jService.run(FILES_MENTIONING_QUERY, {
      projectId,
      filePaths: undecidedFiles,
      names: [...memberNames],
    });
    for (const row of mentioning) dependentFiles.add(row.filePath);
  }
  return [...dependentFiles];
};
