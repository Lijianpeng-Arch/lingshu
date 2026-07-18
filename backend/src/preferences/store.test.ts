import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createSqlite } from '../db/sqlite.js';
import { createPreferenceStore, type PreferenceStore } from './store.js';

let store: PreferenceStore;
let db: Database.Database;

function setup(): PreferenceStore {
  const dir = mkdtempSync(join(tmpdir(), 'lingshu-pref-'));
  const dbPath = join(dir, 'pref.sqlite');
  db = createSqlite(dbPath);
  return createPreferenceStore(db);
}

beforeEach(() => {
  store = setup();
});

describe('preferences/store', () => {
  it('get/set: round-trips JSON-encoded value', () => {
    expect(store.get('default_mode')).toBeUndefined();
    store.set('default_mode', 'smart', { source: 'explicit' });
    expect(store.get('default_mode')).toBe('smart');
  });

  it('set: stores complex value as JSON (objects, arrays)', () => {
    store.set('favorite_tools', ['delete_file', 'edit_file'], { source: 'inferred', confidence: 0.6 });
    expect(store.get('favorite_tools')).toEqual(['delete_file', 'edit_file']);
  });

  it('set: defaults confidence to 1.0 when omitted', () => {
    store.set('language', 'zh');
    const row = db.prepare('SELECT confidence, source FROM preferences WHERE key = ?').get('language') as
      | { confidence: number; source: string }
      | undefined;
    expect(row?.confidence).toBe(1.0);
    expect(row?.source).toBe('explicit');
  });

  it('set: updates existing key (overwrite + bump updated_at)', () => {
    store.set('theme', 'dark', { confidence: 0.4, source: 'inferred' });
    const firstRow = db.prepare('SELECT confidence, updated_at FROM preferences WHERE key = ?').get('theme') as
      | { confidence: number; updated_at: number };
    const firstAt = firstRow.updated_at;
    db.prepare('UPDATE preferences SET updated_at = updated_at + 1 WHERE key = ?').run('theme'); // simulate time passing

    store.set('theme', 'light', { source: 'explicit' });
    const secondRow = db.prepare('SELECT value, confidence, source FROM preferences WHERE key = ?').get('theme') as
      | { value: string; confidence: number; source: string };
    expect(JSON.parse(secondRow.value)).toBe('light');
    expect(secondRow.confidence).toBe(1.0);
    expect(secondRow.source).toBe('explicit');
    expect(secondRow.confidence).not.toBe(firstRow.confidence);
    const updatedAt = (db.prepare('SELECT updated_at FROM preferences WHERE key = ?').get('theme') as { updated_at: number }).updated_at;
    expect(updatedAt).toBeGreaterThanOrEqual(firstAt);
  });

  it('set: stores undefined preference value as JSON null (preserves key)', () => {
    store.set('not_set_key', null as unknown as undefined);
    const raw = db.prepare('SELECT value FROM preferences WHERE key = ?').get('not_set_key') as { value: string };
    expect(raw.value).toBe('null');
    expect(store.get('not_set_key')).toBeNull();
  });

  it('list: returns all preferences, sorted by key', () => {
    store.set('b', '2', { source: 'explicit' });
    store.set('a', '1', { source: 'explicit' });
    store.set('c', '3', { source: 'explicit' });
    const all = store.list();
    expect(all.map((p) => p.key)).toEqual(['a', 'b', 'c']);
    expect(all.every((p) => p.source === 'explicit')).toBe(true);
  });

  it('delete: removes key, get returns undefined', () => {
    store.set('temp', 'x', { source: 'explicit' });
    expect(store.get('temp')).toBe('x');
    store.delete('temp');
    expect(store.get('temp')).toBeUndefined();
  });

  it('get: invalid JSON throws (corrupt state, not silently swallowed)', () => {
    db.prepare('INSERT INTO preferences (key, value, confidence, source, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('broken', 'not-json{', 1, 'explicit', Date.now());
    expect(() => store.get('broken')).toThrow();
  });
});

describe('preferences/store — mergePreferences', () => {
  beforeEach(() => {
    store = setup();
  });

  it('inferred + new: increments confidence (max 1.0)', () => {
    store.set('mode', 'goal', { source: 'inferred', confidence: 0.3 });
    store.merge('mode', 'goal', 'inferred');
    store.merge('mode', 'goal', 'inferred');
    const got = store.get('mode');
    expect(got).toBe('goal');
    const rec = store.list().find((p) => p.key === 'mode')!;
    expect(rec.confidence).toBeGreaterThan(0.3);
    expect(rec.confidence).toBeLessThanOrEqual(1.0);
    expect(rec.source).toBe('inferred');
  });

  it('inferred conflict: resets confidence to 0.1 (still inferred)', () => {
    store.set('mode', 'goal', { source: 'inferred', confidence: 0.8 });
    store.merge('mode', 'plan', 'inferred');
    const rec = store.list().find((p) => p.key === 'mode')!;
    expect(rec.confidence).toBeLessThanOrEqual(0.5);
    expect(store.get('mode')).toBe('plan');
  });
});
