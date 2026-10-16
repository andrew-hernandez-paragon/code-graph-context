import { describe, expect, it } from 'vitest';

import { selectNeo4jProvider } from '../select-neo4j-provider.js';

describe('selectNeo4jProvider', () => {
  it('defaults to native on macOS with Homebrew', () => {
    expect(selectNeo4jProvider({ platform: 'darwin', brewAvailable: true })).toBe('native');
  });

  it.each([
    ['macOS without Homebrew', 'darwin', false],
    ['Linux', 'linux', true],
    ['Windows', 'win32', false],
  ] as const)('defaults to docker on %s', (_name, platform, brewAvailable) => {
    expect(selectNeo4jProvider({ platform, brewAvailable })).toBe('docker');
  });

  it('lets --docker override the macOS default and --native override docker platforms', () => {
    expect(selectNeo4jProvider({ docker: true, platform: 'darwin', brewAvailable: true })).toBe('docker');
    expect(selectNeo4jProvider({ native: true, platform: 'linux', brewAvailable: false })).toBe('native');
  });

  it('rejects both flags together', () => {
    expect(() => selectNeo4jProvider({ native: true, docker: true, platform: 'darwin', brewAvailable: true })).toThrow(
      'Choose either --native or --docker',
    );
  });
});
