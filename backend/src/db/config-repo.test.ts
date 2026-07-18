import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqlite } from './sqlite.js';
import { createConfigRepo } from './config-repo.js';
import type { ProviderConfig } from '../providers/types.js';

describe('createConfigRepo', () => {
  let dir: string, dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lingshu-repo-'));
    dbPath = join(dir, 'test.sqlite');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('upserts and retrieves a provider', () => {
    const db = createSqlite(dbPath);
    const repo = createConfigRepo(db);
    const cfg: ProviderConfig = { name: 'deepseek', apiKey: 'sk-test', baseURL: 'https://api.deepseek.com', capabilities: ['chat'], timeoutMs: 15000 };
    repo.upsertProvider(cfg);
    expect(repo.getProvider('deepseek')?.apiKey).toBe('sk-test');
    db.close();
  });
  it('returns undefined for unknown', () => {
    const db = createSqlite(dbPath);
    expect(createConfigRepo(db).getProvider('nope')).toBeUndefined();
    db.close();
  });
  it('lists all providers', () => {
    const db = createSqlite(dbPath);
    const repo = createConfigRepo(db);
    repo.upsertProvider({ name: 'a', apiKey: 'k', baseURL: 'https://a', capabilities: ['chat'], timeoutMs: 15000 });
    repo.upsertProvider({ name: 'b', apiKey: 'k', baseURL: 'https://b', capabilities: ['chat'], timeoutMs: 15000 });
    expect(repo.listProviders().map(p => p.name).sort()).toEqual(['a', 'b']);
    db.close();
  });
  it('upsert updates existing', () => {
    const db = createSqlite(dbPath);
    const repo = createConfigRepo(db);
    repo.upsertProvider({ name: 'd', apiKey: 'old', baseURL: 'https://d', capabilities: ['chat'], timeoutMs: 15000 });
    repo.upsertProvider({ name: 'd', apiKey: 'new', baseURL: 'https://d', capabilities: ['chat'], timeoutMs: 15000 });
    expect(repo.getProvider('d')?.apiKey).toBe('new');
    db.close();
  });
  it('deleteProvider removes it', () => {
    const db = createSqlite(dbPath);
    const repo = createConfigRepo(db);
    repo.upsertProvider({ name: 'x', apiKey: 'k', baseURL: 'https://x', capabilities: ['chat'], timeoutMs: 15000 });
    expect(repo.deleteProvider('x')).toBe(true);
    expect(repo.getProvider('x')).toBeUndefined();
    db.close();
  });
  it('roundtrips optional fields', () => {
    const db = createSqlite(dbPath);
    const repo = createConfigRepo(db);
    repo.upsertProvider({
      name: 'c', apiKey: 'k', baseURL: 'https://c', capabilities: ['chat'], timeoutMs: 15000,
      probeModel: 'fast', extraHeaders: { 'X-Custom': 'value' },
    });
    const got = repo.getProvider('c');
    expect(got?.probeModel).toBe('fast');
    expect(got?.extraHeaders).toEqual({ 'X-Custom': 'value' });
    db.close();
  });
});
