import { describe, expect, it } from 'vitest';
import { __splitArgsForTest } from './github.js';

describe('splitArgs', () => {
  it('plain tokens', () => {
    expect(__splitArgsForTest('pr view 123')).toEqual(['pr', 'view', '123']);
  });
  it('double-quoted string preserved', () => {
    expect(__splitArgsForTest('issue create --title "hello world" -b body')).toEqual([
      'issue',
      'create',
      '--title',
      'hello world',
      '-b',
      'body',
    ]);
  });
  it('single-quoted string preserved', () => {
    expect(__splitArgsForTest("api '/repos/foo/bar/issues?state=open'")).toEqual([
      'api',
      '/repos/foo/bar/issues?state=open',
    ]);
  });
  it('empty string → []', () => {
    expect(__splitArgsForTest('')).toEqual([]);
  });
});
