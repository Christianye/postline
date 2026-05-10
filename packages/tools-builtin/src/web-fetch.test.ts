import { describe, expect, it } from 'vitest';
import { __isBlockedForTest } from './web-fetch.js';

describe('web-fetch host policy', () => {
  const deny = ['localhost', '127.0.0.1', '169.254.169.254', '.internal'];
  it('blocks localhost', () => {
    expect(__isBlockedForTest('localhost', deny)).toBe(true);
  });
  it('blocks IMDS metadata', () => {
    expect(__isBlockedForTest('169.254.169.254', deny)).toBe(true);
  });
  it('blocks .internal suffix', () => {
    expect(__isBlockedForTest('foo.internal', deny)).toBe(true);
  });
  it('blocks RFC1918', () => {
    expect(__isBlockedForTest('10.0.0.5', deny)).toBe(true);
    expect(__isBlockedForTest('192.168.1.1', deny)).toBe(true);
    expect(__isBlockedForTest('172.16.0.1', deny)).toBe(true);
  });
  it('allows public hostnames', () => {
    expect(__isBlockedForTest('api.github.com', deny)).toBe(false);
    expect(__isBlockedForTest('example.com', deny)).toBe(false);
    expect(__isBlockedForTest('8.8.8.8', deny)).toBe(false);
  });
  it('allows CGNAT block is treated as private (carrier-grade)', () => {
    expect(__isBlockedForTest('100.64.0.1', deny)).toBe(true);
  });
});
