import { describe, expect, it } from 'vitest';

import { readListenPorts } from '../migration-environment.js';

describe('readListenPorts', () => {
  it('reads the Bolt and HTTP ports from the managed block', () => {
    const conf = [
      'server.default_listen_address=127.0.0.1',
      'server.bolt.listen_address=127.0.0.1:27687',
      'server.http.listen_address=127.0.0.1:27474',
    ].join('\n');
    expect(readListenPorts(conf)).toEqual({ boltPort: 27687, httpPort: 27474 });
  });

  it('returns null when a port is missing', () => {
    expect(readListenPorts('server.bolt.listen_address=127.0.0.1:7687\n')).toBeNull();
    expect(readListenPorts('')).toBeNull();
  });
});
