import { join } from 'path';

export interface NativeNeo4jPaths {
  home: string;
  conf: string;
  data: string;
  logs: string;
  plugins: string;
  run: string;
  import: string;
}

export interface ManagedConfSettings {
  paths: NativeNeo4jPaths;
  boltPort: number;
  httpPort: number;
  heapMax: string;
  pagecache: string;
}

export const MANAGED_BLOCK_BEGIN = '# BEGIN code-graph-context managed settings';
export const MANAGED_BLOCK_END = '# END code-graph-context managed settings';

const HEAP_INITIAL_SIZE = '1G';
const LISTEN_ADDRESS = '127.0.0.1';

const MANAGED_KEY_PREFIXES = ['server.directories.'];
const MANAGED_KEYS = new Set([
  'server.default_listen_address',
  'server.bolt.listen_address',
  'server.http.listen_address',
  'server.memory.heap.initial_size',
  'server.memory.heap.max_size',
  'server.memory.pagecache.size',
  'db.tx_log.rotation.retention_policy',
  'db.tx_log.rotation.size',
  'db.tx_log.preallocate',
  'dbms.security.procedures.unrestricted',
  'db.query.default_language',
]);

const SIZE_UNIT_BYTES: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

const parseSizeBytes = (size: string): number | null => {
  const match = /^(\d+)([kmg])$/i.exec(size.trim());
  return match ? Number(match[1]) * SIZE_UNIT_BYTES[match[2].toLowerCase()] : null;
};

// Neo4j refuses to start when the initial heap exceeds the maximum.
const heapInitialSize = (heapMax: string): string => {
  const max = parseSizeBytes(heapMax);
  const initial = parseSizeBytes(HEAP_INITIAL_SIZE);
  return max !== null && initial !== null && max < initial ? heapMax : HEAP_INITIAL_SIZE;
};

export const resolveNativePaths = (home: string): NativeNeo4jPaths => ({
  home,
  conf: join(home, 'conf'),
  data: join(home, 'data'),
  logs: join(home, 'logs'),
  plugins: join(home, 'plugins'),
  run: join(home, 'run'),
  import: join(home, 'import'),
});

const setsManagedKey = (line: string): boolean => {
  const match = /^\s*([A-Za-z0-9_.]+)\s*=/.exec(line);
  if (!match) return false;
  const key = match[1];
  return MANAGED_KEYS.has(key) || MANAGED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
};

/** The stock conf with every managed setting dropped, then one managed block appended. */
export const renderNeo4jConf = (stockConf: string, settings: ManagedConfSettings): string => {
  const { paths, boltPort, httpPort, heapMax, pagecache } = settings;
  const kept = stockConf
    .split('\n')
    .filter((line) => !setsManagedKey(line))
    .join('\n')
    .trimEnd();
  const block = [
    MANAGED_BLOCK_BEGIN,
    `server.directories.data=${paths.data}`,
    `server.directories.logs=${paths.logs}`,
    `server.directories.plugins=${paths.plugins}`,
    `server.directories.run=${paths.run}`,
    `server.directories.import=${paths.import}`,
    `server.default_listen_address=${LISTEN_ADDRESS}`,
    `server.bolt.listen_address=${LISTEN_ADDRESS}:${boltPort}`,
    `server.http.listen_address=${LISTEN_ADDRESS}:${httpPort}`,
    `server.memory.heap.initial_size=${heapInitialSize(heapMax)}`,
    `server.memory.heap.max_size=${heapMax}`,
    `server.memory.pagecache.size=${pagecache}`,
    'db.tx_log.rotation.retention_policy=keep_none',
    'db.tx_log.rotation.size=64M',
    'db.tx_log.preallocate=false',
    'dbms.security.procedures.unrestricted=apoc.*',
    'db.query.default_language=CYPHER_5',
    MANAGED_BLOCK_END,
  ].join('\n');
  return `${kept}\n\n${block}\n`;
};

const escapeXml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface LaunchdPlistSettings {
  label: string;
  neo4jBin: string;
  confDir: string;
  logPath: string;
}

export const renderLaunchdPlist = ({ label, neo4jBin, confDir, logPath }: LaunchdPlistSettings): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(neo4jBin)}</string>
    <string>console</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NEO4J_CONF</key>
    <string>${escapeXml(confDir)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
