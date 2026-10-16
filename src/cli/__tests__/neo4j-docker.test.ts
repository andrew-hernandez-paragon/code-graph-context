import { describe, expect, it } from 'vitest';

import { parsePublishedPorts } from '../neo4j-docker.js';

describe('parsePublishedPorts', () => {
  it('maps the container Bolt and HTTP ports to their host ports', () => {
    expect(
      parsePublishedPorts('7474/tcp -> 0.0.0.0:7474\n7687/tcp -> 0.0.0.0:17687\n7687/tcp -> [::]:17687\n'),
    ).toEqual({
      boltPort: 17687,
      httpPort: 7474,
    });
  });

  it('returns null when a port is not published', () => {
    expect(parsePublishedPorts('7474/tcp -> 0.0.0.0:7474\n')).toBeNull();
    expect(parsePublishedPorts('')).toBeNull();
  });
});
