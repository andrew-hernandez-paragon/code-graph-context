import { describe, expect, it } from 'vitest';

import { createEmptyResponse, withWarnings } from '../utils.js';

describe('withWarnings', () => {
  it('leaves the response alone when there is nothing to report', () => {
    expect(withWarnings('{"a":1}', [])).toBe('{"a":1}');
  });

  it('adds warnings to a JSON object and keeps the ones already there', () => {
    const text = withWarnings('{"a":1,"warnings":["first"]}', ['second']);

    expect(JSON.parse(text)).toEqual({ a: 1, warnings: ['first', 'second'] });
  });

  it('keeps a plain sentence as the message', () => {
    expect(JSON.parse(withWarnings('No connections found.', ['w']))).toEqual({
      message: 'No connections found.',
      warnings: ['w'],
    });
  });
});

describe('createEmptyResponse', () => {
  it('carries warnings only when given', () => {
    const plain = JSON.parse(createEmptyResponse('none').content[0].text);
    const warned = JSON.parse(createEmptyResponse('none', 'try', ['w']).content[0].text);

    expect(plain).toEqual({ status: 'empty', message: 'none' });
    expect(warned).toEqual({ status: 'empty', message: 'none', suggestion: 'try', warnings: ['w'] });
  });
});
