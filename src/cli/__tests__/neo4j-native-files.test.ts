import { describe, expect, it } from 'vitest';

import { renderLaunchdPlist, renderNeo4jConf, resolveNativePaths } from '../neo4j-native-files.js';

const STOCK_CONF = `# header comment
#server.directories.data=commented/stays
db.query.default_language=CYPHER_25
server.directories.import=import
server.bolt.enabled=true
server.memory.heap.max_size=8G
  server.memory.pagecache.size = 4G
server.jvm.additional=-XX:+UseG1GC
dbms.security.procedures.unrestricted=other.*
server.directories.data=/opt/homebrew/var/neo4j/data`;

const paths = resolveNativePaths('/h/neo4j');

const settings = { paths, boltPort: 27687, httpPort: 27474, heapMax: '2G', pagecache: '1G' };

describe('renderNeo4jConf', () => {
  it('drops managed settings from the stock conf and appends one managed block', () => {
    expect(renderNeo4jConf(STOCK_CONF, settings)).toBe(`# header comment
#server.directories.data=commented/stays
server.bolt.enabled=true
server.jvm.additional=-XX:+UseG1GC

# BEGIN code-graph-context managed settings
server.directories.data=/h/neo4j/data
server.directories.logs=/h/neo4j/logs
server.directories.plugins=/h/neo4j/plugins
server.directories.run=/h/neo4j/run
server.directories.import=/h/neo4j/import
server.default_listen_address=127.0.0.1
server.bolt.listen_address=127.0.0.1:27687
server.http.listen_address=127.0.0.1:27474
server.memory.heap.initial_size=1G
server.memory.heap.max_size=2G
server.memory.pagecache.size=1G
db.tx_log.rotation.retention_policy=keep_none
db.tx_log.rotation.size=64M
db.tx_log.preallocate=false
dbms.security.procedures.unrestricted=apoc.*
db.query.default_language=CYPHER_5
# END code-graph-context managed settings
`);
  });

  it('gives the same output when rendered twice from the same stock conf', () => {
    expect(renderNeo4jConf(STOCK_CONF, settings)).toBe(renderNeo4jConf(STOCK_CONF, settings));
  });

  it('lowers the initial heap to a maximum below 1G', () => {
    expect(renderNeo4jConf(STOCK_CONF, { ...settings, heapMax: '512M' })).toContain(
      'server.memory.heap.initial_size=512M\nserver.memory.heap.max_size=512M\n',
    );
  });
});

describe('renderLaunchdPlist', () => {
  it('runs neo4j console with NEO4J_CONF, restarts it after a failure, and logs to one file', () => {
    expect(
      renderLaunchdPlist({
        label: 'dev.code-graph-context.neo4j',
        neo4jBin: '/opt/homebrew/opt/neo4j/bin/neo4j',
        confDir: '/h/neo4j/conf',
        logPath: '/h/neo4j/logs/launchd.log',
      }),
    ).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.code-graph-context.neo4j</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/neo4j/bin/neo4j</string>
    <string>console</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NEO4J_CONF</key>
    <string>/h/neo4j/conf</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>/h/neo4j/logs/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>/h/neo4j/logs/launchd.log</string>
</dict>
</plist>
`);
  });
});
