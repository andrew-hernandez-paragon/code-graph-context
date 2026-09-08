import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { LOG_CONFIG } from '../../constants.js';

export const hashFile = async (filePath: string): Promise<string> => {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
};

const serializeForLog = (data: any): any => {
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  if (data !== null && typeof data === 'object') {
    const result: Record<string, any> = {};
    for (const key of Object.keys(data)) {
      result[key] = serializeForLog(data[key]);
    }
    return result;
  }
  return data;
};

const isDebugLogEnabled = (): boolean => process.env.CGC_DEBUG === '1' || process.env.CGC_DEBUG === 'true';

export const debugLog = async (message: string, data?: any): Promise<void> => {
  if (!isDebugLogEnabled()) return;

  const timestamp = new Date().toISOString();
  const serialized = data !== undefined ? serializeForLog(data) : undefined;
  const logEntry = `[${timestamp}] ${message}\n${serialized !== undefined ? JSON.stringify(serialized, null, LOG_CONFIG.jsonIndent) : ''}\n${LOG_CONFIG.separator}\n`;

  try {
    await fs.appendFile(path.join(process.cwd(), LOG_CONFIG.debugLogFile), logEntry);
  } catch (error) {
    console.error('Failed to write debug log:', error);
  }
};

/**
 * Safely test if a file path matches a pattern (string or regex).
 * Falls back to literal string matching if the pattern is an invalid regex.
 */
export const matchesPattern = (filePath: string, pattern: string): boolean => {
  // First try literal string match (always safe)
  if (filePath.includes(pattern)) {
    return true;
  }
  // Then try regex match with error handling
  try {
    return new RegExp(pattern).test(filePath);
  } catch {
    // Invalid regex pattern - already checked via includes() above
    return false;
  }
};

/**
 * Clean up a TypeScript type name by removing generics, imports, etc.
 * Examples:
 *   import("./foo").ClassName -> ClassName
 *   ClassName<T> -> ClassName
 *   ClassName[] -> ClassName
 */
export const cleanTypeName = (typeName: string): string => {
  // Remove import paths: import("...").ClassName -> ClassName
  let cleaned = typeName.replace(/import\([^)]+\)\./g, '');
  // Remove generics: ClassName<T> -> ClassName
  const genericIndex = cleaned.indexOf('<');
  if (genericIndex > 0) {
    cleaned = cleaned.substring(0, genericIndex);
  }
  // Remove array notation: ClassName[] -> ClassName
  cleaned = cleaned.replace(/\[\]$/, '');
  return cleaned.trim();
};
