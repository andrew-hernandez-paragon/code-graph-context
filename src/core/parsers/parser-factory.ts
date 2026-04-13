/**
 * Parser Factory
 * Creates TypeScript parsers with appropriate framework schemas
 */

import { EXCLUDE_PATTERNS_REGEX } from '../../constants.js';
import { FAIRSQUARE_FRAMEWORK_SCHEMA } from '../config/fairsquare-framework-schema.js';
import { NESTJS_FRAMEWORK_SCHEMA } from '../config/nestjs-framework-schema.js';
import { CORE_TYPESCRIPT_SCHEMA, FrameworkSchema, CoreNodeType } from '../config/schema.js';

import { TypeScriptParser } from './typescript-parser.js';

export enum ProjectType {
  NESTJS = 'nestjs',
  FAIRSQUARE = 'fairsquare',
  BOTH = 'both', // For codebases with mixed patterns
  VANILLA = 'vanilla', // Plain TypeScript, no frameworks
}

export interface ParserFactoryOptions {
  workspacePath: string;
  tsConfigPath?: string;
  projectType?: ProjectType;
  customFrameworkSchemas?: FrameworkSchema[];
  excludePatterns?: string[];
  excludedNodeTypes?: CoreNodeType[];
  projectId?: string; // Optional - derived from workspacePath if not provided
  lazyLoad?: boolean; // Set to true for large projects to avoid OOM
}

export class ParserFactory {
  /**
   * Create a parser with appropriate framework schemas
   */
  static createParser(options: ParserFactoryOptions): TypeScriptParser {
    const {
      workspacePath,
      tsConfigPath = 'tsconfig.json',
      projectType = ProjectType.NESTJS, // Default to NestJS (use auto-detect for best results)
      customFrameworkSchemas = [],
      excludePatterns = EXCLUDE_PATTERNS_REGEX,
      excludedNodeTypes = [CoreNodeType.PARAMETER_DECLARATION],
      projectId,
      lazyLoad = false,
    } = options;

    // Select framework schemas based on project type
    const frameworkSchemas = this.selectFrameworkSchemas(projectType, customFrameworkSchemas);

    console.error(`📦 Creating parser for ${projectType} project`);
    console.error(`📚 Framework schemas: ${frameworkSchemas.map((s) => s.name).join(', ')}`);

    return new TypeScriptParser(
      workspacePath,
      tsConfigPath,
      CORE_TYPESCRIPT_SCHEMA,
      frameworkSchemas,
      {
        excludePatterns,
        excludedNodeTypes,
      },
      projectId,
      lazyLoad,
    );
  }

  /**
   * Select framework schemas based on project type
   */
  private static selectFrameworkSchemas(projectType: ProjectType, customSchemas: FrameworkSchema[]): FrameworkSchema[] {
    const schemas: FrameworkSchema[] = [];

    switch (projectType) {
      case ProjectType.NESTJS:
        schemas.push(NESTJS_FRAMEWORK_SCHEMA);
        break;

      case ProjectType.FAIRSQUARE:
        schemas.push(FAIRSQUARE_FRAMEWORK_SCHEMA);
        break;

      case ProjectType.BOTH:
        // Apply FairSquare first (higher priority), then NestJS
        schemas.push(FAIRSQUARE_FRAMEWORK_SCHEMA);
        schemas.push(NESTJS_FRAMEWORK_SCHEMA);
        break;

      case ProjectType.VANILLA:
        // No framework schemas
        break;
    }

    // Add any custom schemas
    schemas.push(...customSchemas);

    return schemas;
  }

  /**
   * Auto-detect project type from workspace. Checks root package.json first,
   * and for monorepos also scans workspace packages so NestJS declared only
   * in sub-packages is still detected.
   */
  static async detectProjectType(workspacePath: string): Promise<ProjectType> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const { glob } = await import('glob');

    const hasNestJSDep = (pkg: any): boolean => {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return '@nestjs/common' in deps || '@nestjs/core' in deps;
    };

    const checkPackageJson = async (pkgPath: string): Promise<boolean> => {
      try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
        return hasNestJSDep(pkg);
      } catch {
        return false;
      }
    };

    try {
      // Check root first
      if (await checkPackageJson(path.join(workspacePath, 'package.json'))) {
        return ProjectType.NESTJS;
      }

      // Scan sub-package.json files for monorepos (turborepo, npm/yarn/pnpm workspaces).
      const subPackageJsons = await glob('*/*/package.json', {
        cwd: workspacePath,
        ignore: ['**/node_modules/**'],
        absolute: true,
      });
      for (const pkgPath of subPackageJsons) {
        if (await checkPackageJson(pkgPath)) {
          return ProjectType.NESTJS;
        }
      }

      return ProjectType.VANILLA;
    } catch (error) {
      console.warn('Could not detect project type, defaulting to vanilla TypeScript');
      return ProjectType.VANILLA;
    }
  }

  /**
   * Create parser with auto-detection
   */
  static async createParserWithAutoDetection(
    workspacePath: string,
    tsConfigPath?: string,
    projectId?: string,
    lazyLoad: boolean = false,
  ): Promise<TypeScriptParser> {
    const projectType = await this.detectProjectType(workspacePath);
    console.error(`🔍 Auto-detected project type: ${projectType}`);

    return this.createParser({
      workspacePath,
      tsConfigPath,
      projectType,
      projectId,
      lazyLoad,
    });
  }
}
