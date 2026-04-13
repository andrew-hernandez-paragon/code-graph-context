export const MAX_TRAVERSAL_DEPTH = 5;

// Logging Configuration (shared between core and mcp)
export const LOG_CONFIG = {
  debugLogFile: 'debug-search.log',
  separator: '---',
  jsonIndent: 2,
  // Alias for backwards compatibility with mcp code
  jsonIndentation: 2,
} as const;

// Shared exclude patterns for file parsing and change detection
// Regex patterns (escaped dots, anchored to end)
export const EXCLUDE_PATTERNS_REGEX = [
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '\\.d\\.ts$',
  '\\.spec\\.ts$',
  '\\.test\\.ts$',
  // Common config and test infrastructure files
  'jest\\.config\\.ts$',
  '-e2e/',
  'test-setup\\.ts$',
  'global-setup\\.ts$',
  'global-teardown\\.ts$',
];

// Glob patterns for use with glob library
export const EXCLUDE_PATTERNS_GLOB = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/*.d.ts',
  '**/*.spec.ts',
  '**/*.test.ts',
  // Common config and test infrastructure files
  '**/jest.config.ts',
  '**/*-e2e/**',
  '**/test-setup.ts',
  '**/global-setup.ts',
  '**/global-teardown.ts',
];

// ============================================
// CALLS Edge Detection - Built-in Identifiers
// Skip these when extracting CALLS edges to reduce noise
// ============================================

/** Built-in function names to skip when extracting CALLS edges */
export const BUILT_IN_FUNCTIONS = new Set([
  'console',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
  'JSON',
  'Math',
  'Date',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Promise',
  'require',
  'eval',
]);

/** Built-in method names to skip when extracting CALLS edges */
export const BUILT_IN_METHODS = new Set([
  // Array methods
  'push',
  'pop',
  'shift',
  'unshift',
  'slice',
  'splice',
  'concat',
  'join',
  'reverse',
  'sort',
  'indexOf',
  'lastIndexOf',
  'includes',
  'find',
  'findIndex',
  'filter',
  'map',
  'reduce',
  'reduceRight',
  'every',
  'some',
  'forEach',
  'flat',
  'flatMap',
  'fill',
  'entries',
  'keys',
  'values',
  // String methods
  'charAt',
  'charCodeAt',
  'substring',
  'substr',
  'split',
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'replace',
  'replaceAll',
  'match',
  'search',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  // Object methods
  'hasOwnProperty',
  'toString',
  'valueOf',
  'toJSON',
  // Promise methods
  'then',
  'catch',
  'finally',
  // Console methods
  'log',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'dir',
  'table',
  // Common utilities
  'bind',
  'call',
  'apply',
]);

/** Built-in class names to skip when extracting constructor calls */
export const BUILT_IN_CLASSES = new Set([
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Proxy',
  'Reflect',
  'Symbol',
  'BigInt',
  'ArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'Buffer',
  'EventEmitter',
]);
