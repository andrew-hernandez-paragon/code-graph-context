/**
 * Dependent Files
 * Finds the unchanged files whose edges into reparsed files cannot be restored by node id.
 */

import { basename, dirname, resolve } from 'path';

import { CoreEdgeType, CoreNodeType, type Neo4jNode } from '../../core/config/schema.js';
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

export const SUBTYPE_EDGES_QUERY = `
  MATCH (subtype:GraphNode)-[r:${CoreEdgeType.EXTENDS}|${CoreEdgeType.IMPLEMENTS}]->(supertype:GraphNode)
  WHERE subtype.projectId = $projectId AND supertype.projectId = $projectId
  RETURN subtype.id AS subtypeId,
         subtype.name AS subtypeName,
         subtype.filePath AS subtypeFilePath,
         type(r) AS edgeType,
         supertype.id AS supertypeId,
         supertype.name AS supertypeName,
         supertype.coreType AS supertypeType,
         supertype.filePath AS supertypeFilePath
`;

// The parser stores no node for a re-export, so a barrel is recognized by its source text.
const RE_EXPORT = /\bexport\b[^;]*?\bfrom\s*['"]/;
const RE_EXPORT_CYPHER_PATTERN = `(?s).*${RE_EXPORT.source}.*`;

export const RE_EXPORTING_FILES_QUERY = `
  MATCH (file:SourceFile)
  WHERE file.projectId = $projectId AND file.filePath IN $filePaths AND file.sourceCode =~ $reExportPattern
  RETURN file.filePath AS filePath
`;

export const IMPORTERS_QUERY = `
  MATCH (target:SourceFile)
  WHERE target.projectId = $projectId AND target.filePath IN $filePaths
  MATCH (importer:SourceFile)-[:${CoreEdgeType.IMPORTS}]->(target)
  WHERE importer.projectId = $projectId
  RETURN DISTINCT importer.filePath AS filePath, importer.sourceCode =~ $reExportPattern AS reExports
`;

export const DELETE_OUTGOING_EDGES_QUERY = `
  MATCH (source:GraphNode)
  WHERE source.projectId = $projectId AND source.filePath IN $filePaths
  MATCH (source)-[r]->(:GraphNode)
  DELETE r
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

/** A class or interface and one type it extends or implements, as stored in the graph or produced by a parse. */
export interface SubtypeEdge {
  subtypeId: string;
  subtypeName: string;
  subtypeFilePath: string;
  edgeType: string;
  supertypeId: string;
  supertypeName: string;
  supertypeType: string;
  supertypeFilePath: string;
}

export const loadSubtypeEdges = async (neo4jService: Neo4jService, projectId: string): Promise<SubtypeEdge[]> => {
  const rows = await neo4jService.run(SUBTYPE_EDGES_QUERY, { projectId });
  return rows.map((row) => ({
    subtypeId: row.subtypeId,
    subtypeName: row.subtypeName,
    subtypeFilePath: row.subtypeFilePath,
    edgeType: row.edgeType,
    supertypeId: row.supertypeId,
    supertypeName: row.supertypeName,
    supertypeType: row.supertypeType,
    supertypeFilePath: row.supertypeFilePath,
  }));
};

export const deleteOutgoingEdges = async (
  neo4jService: Neo4jService,
  filePaths: string[],
  projectId: string,
): Promise<void> => {
  await neo4jService.run(DELETE_OUTGOING_EDGES_QUERY, { filePaths, projectId });
};

/** The files among `filePaths` that hold a re-export in the graph. */
export const findReExportingFiles = async (
  neo4jService: Neo4jService,
  filePaths: string[],
  projectId: string,
): Promise<string[]> => {
  const rows = await neo4jService.run(RE_EXPORTING_FILES_QUERY, {
    filePaths,
    projectId,
    reExportPattern: RE_EXPORT_CYPHER_PATTERN,
  });
  return rows.map((row) => row.filePath);
};

/** The files among freshly parsed `nodes` that hold a re-export. */
export const reExportingFilesOf = (nodes: Neo4jNode[]): string[] =>
  nodes
    .filter(
      ({ properties }) => properties.coreType === CoreNodeType.SOURCE_FILE && RE_EXPORT.test(properties.sourceCode),
    )
    .map(({ properties }) => properties.filePath);

/**
 * The files that import one of the barrels `barrelPaths`, directly or through other barrels. An
 * importer holds an edge to the file that declares each name it takes through a barrel, so when a
 * barrel's re-exports change every such importer has edges only a parse of it can correct.
 */
export const findImportersThroughReExports = async (
  neo4jService: Neo4jService,
  barrelPaths: string[],
  projectId: string,
): Promise<string[]> => {
  const importers = new Set<string>();
  let barrels = barrelPaths;
  const visited = new Set(barrels);
  while (barrels.length > 0) {
    const rows = await neo4jService.run(IMPORTERS_QUERY, {
      filePaths: barrels,
      projectId,
      reExportPattern: RE_EXPORT_CYPHER_PATTERN,
    });
    barrels = [];
    for (const row of rows) {
      importers.add(row.filePath);
      if (row.reExports && !visited.has(row.filePath)) {
        visited.add(row.filePath);
        barrels.push(row.filePath);
      }
    }
  }
  return [...importers];
};

export interface SubtypeChanges {
  /** Supertypes that a reparsed class or interface started or stopped extending or implementing. */
  changedSupertypeNames: string[];
  /** The supertypes of each reparsed class, by class name. */
  supertypeNamesByClass: Map<string, string[]>;
}

const edgeKey = (edge: SubtypeEdge): string => `${edge.subtypeId}|${edge.edgeType}|${edge.supertypeId}`;

/** A call through a supertype links to every subtype's method, so a changed subtype edge changes its callers' edges. */
export const describeSubtypeChanges = (previous: SubtypeEdge[], current: SubtypeEdge[]): SubtypeChanges => {
  const previousKeys = new Set(previous.map(edgeKey));
  const currentKeys = new Set(current.map(edgeKey));
  const changed = [
    ...previous.filter((edge) => !currentKeys.has(edgeKey(edge))),
    ...current.filter((edge) => !previousKeys.has(edgeKey(edge))),
  ];
  const supertypeNamesByClass = new Map<string, string[]>();
  for (const edge of current) {
    supertypeNamesByClass.set(edge.subtypeName, [
      ...(supertypeNamesByClass.get(edge.subtypeName) ?? []),
      edge.supertypeName,
    ]);
  }
  return { changedSupertypeNames: [...new Set(changed.map((edge) => edge.supertypeName))], supertypeNamesByClass };
};

interface NewDeclarations {
  /** Names an import statement would carry: top-level declarations, and classes that gained a constructor. */
  importedNames: Set<string>;
  /** New members by class. An importer of the class can reference one only if its source mentions the member. */
  memberNamesByClass: Map<string, Set<string>>;
  modulePaths: string[];
}

const classifyNewNodes = (newNodes: Neo4jNode[], subtypes: SubtypeChanges): NewDeclarations => {
  const declarations: NewDeclarations = {
    importedNames: new Set(subtypes.changedSupertypeNames),
    memberNamesByClass: new Map(),
    modulePaths: [],
  };
  const addMember = (typeName: string, member: string): void => {
    const members = declarations.memberNamesByClass.get(typeName) ?? new Set();
    declarations.memberNamesByClass.set(typeName, members.add(member));
  };
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
      // A caller typed as a supertype imports the supertype, not the class.
      const typeNames = [parentClassName, ...(subtypes.supertypeNamesByClass.get(parentClassName) ?? [])];
      typeNames.forEach((typeName) => addMember(typeName, name));
    }
  }
  return declarations;
};

/**
 * The files outside `excludeFilePaths` that can hold a reference to one of `newNodes`: they import a
 * new declaration by name, import a class or its supertype and mention its new member, import a new
 * file, or import a supertype whose subtypes changed.
 * `newNodes` are nodes the graph did not hold before the reparse (a renamed or added declaration, or
 * anything in a new file), so no saved edge points at them and only a parse of the importer finds its edges.
 */
export const findDependentFiles = async (
  neo4jService: Neo4jService,
  newNodes: Neo4jNode[],
  subtypes: SubtypeChanges,
  excludeFilePaths: string[],
  projectId: string,
): Promise<string[]> => {
  const { importedNames, memberNamesByClass, modulePaths } = classifyNewNodes(newNodes, subtypes);
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
