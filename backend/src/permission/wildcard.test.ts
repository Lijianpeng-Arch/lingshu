import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { matchWildcard } from './wildcard';

describe('matchWildcard', () => {
  it('matches exact path', () => {
    expect(matchWildcard('~/foo.txt', '~/foo.txt')).toBe(true);
  });
  it('matches single segment *', () => {
    expect(matchWildcard('~/Documents/*', '~/Documents/foo.txt')).toBe(true);
  });
  it('rejects directory with single *', () => {
    expect(matchWildcard('~/Documents/*', '~/Documents/sub/foo.txt')).toBe(false);
  });
  it('matches recursive **', () => {
    expect(matchWildcard('~/Documents/**', '~/Documents/sub/foo.txt')).toBe(true);
  });
  it('expands ~ to home', () => {
    // 用 os.homedir() 与实现保持一致 — Windows 上 process.env.HOME 是 undefined
    expect(matchWildcard('~/foo.txt', `${os.homedir()}/foo.txt`)).toBe(true);
  });
  it('returns false on no match', () => {
    expect(matchWildcard('~/foo.txt', '~/bar.txt')).toBe(false);
  });
});