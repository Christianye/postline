import { describe, expect, it } from 'vitest';
import { __splitArgsForTest, __isReadOnlyGhForTest as isRO } from './github.js';

describe('gh_query read-only gate (audit 2026-06-17)', () => {
  const READ_OK = [
    'pr view 123 --json title,body',
    'issue list',
    'repo view owner/name',
    'search issues "is:open"',
    'api /repos/o/r/issues',
    'api -X GET /rate_limit',
    'api --method GET /user',
    'api /repos/o/r --jq .stargazers_count',
  ];
  const WRITE_BLOCKED = [
    'api -X DELETE /repos/o/r/issues/1',
    'api --method DELETE /x',
    'api --method POST /x',
    'api /repos/o/r/issues -f title=bug', // -f makes gh POST
    'api /x -F body=@file',
    'api /x --field a=b',
    'api /x --raw-field a=b',
    'api /x --input -',
    'pr merge 123',
    'issue create --title x',
    'pr close 5',
  ];
  for (const a of READ_OK) {
    it(`allows: ${a}`, () => expect(isRO(a)).toBe(true));
  }
  for (const a of WRITE_BLOCKED) {
    it(`blocks: ${a}`, () => expect(isRO(a)).toBe(false));
  }
});

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
