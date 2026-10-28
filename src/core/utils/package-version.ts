import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/** The version in package.json; the file sits three levels above both src/core/utils and dist/core/utils. */
export const readPackageVersion = (): string => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return 'unknown';
  }
};
