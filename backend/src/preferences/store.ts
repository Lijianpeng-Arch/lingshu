/**
 * preferences/store — persistent user-preference store
 *
 * Spec 2D — persistent main loop (Phase E in roadmap)
 *
 * Borrowed from:
 *   - ChatGPT Memory (per-key store, confidence score, source attribution)
 *   - 白龙马 preference store (JSON blob per key)
 *
 * 设计:
 *   - key → JSON value, confidence 0..1, source (explicit | inferred)
 *   - 显式 (用户说"记住我喜欢X") → source='explicit', confidence=1.0
 *   - 推断 (LLM 从对话提取) → source='inferred', confidence 0..1
 *   - merge 用法: 推断可信度累加 (同向 +0.2, 冲突 -0.7), 显式胜出
 *
 * SQLite 表结构见 migrations/2026-07-16-add-reminders-prefs.sql.
 */

import type { Database as Db } from 'better-sqlite3';

export type PreferenceSource = 'explicit' | 'inferred';

export interface PreferenceRecord {
  key: string;
  value: unknown;          // 解析后的对象
  raw: string;             // JSON 原文 (debug 用)
  confidence: number;       // 0..1
  source: PreferenceSource;
  updatedAt: number;
}

export interface PreferenceStore {
  get(key: string): unknown;
  set(
    key: string,
    value: unknown,
    opts?: { source?: PreferenceSource; confidence?: number },
  ): void;
  merge(
    key: string,
    value: unknown,
    source: PreferenceSource,
  ): void;
  delete(key: string): void;
  list(): PreferenceRecord[];
}

export interface PreferenceRow {
  key: string;
  value: string;
  confidence: number;
  source: string;
  updated_at: number;
}

export function createPreferenceStore(db: Db): PreferenceStore {
  const insertStmt = db.prepare(`
    INSERT INTO preferences (key, value, confidence, source, updated_at)
    VALUES (@key, @value, @confidence, @source, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      confidence = excluded.confidence,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);
  const getStmt = db.prepare('SELECT * FROM preferences WHERE key = ?');
  const listStmt = db.prepare('SELECT * FROM preferences ORDER BY key');
  const deleteStmt = db.prepare('DELETE FROM preferences WHERE key = ?');

  function readValue(raw: string): unknown {
    // JSON.parse('null') → null  → 这样 store.set(k, null) 之后 get(k) === null
    return JSON.parse(raw);
  }

  return {
    get(key) {
      const row = getStmt.get(key) as PreferenceRow | undefined;
      if (!row) return undefined;
      return readValue(row.value);
    },

    set(key, value, opts = {}) {
      const now = Date.now();
      insertStmt.run({
        key,
        value: JSON.stringify(value ?? null),
        confidence: opts.confidence ?? 1.0,
        source: opts.source ?? 'explicit',
        updated_at: now,
      });
    },

    merge(key, value, source) {
      const existing = getStmt.get(key) as PreferenceRow | undefined;
      const rawValue = JSON.stringify(value ?? null);

      if (!existing) {
        // 第一次写入 — 起点 0.5 (inferred) / 1.0 (explicit)
        const confidence = source === 'explicit' ? 1.0 : 0.5;
        insertStmt.run({
          key,
          value: rawValue,
          confidence,
          source,
          updated_at: Date.now(),
        });
        return;
      }

      // 显式胜出: 任何 explicit 来源都覆盖现有
      if (source === 'explicit') {
        insertStmt.run({
          key,
          value: rawValue,
          confidence: 1.0,
          source: 'explicit',
          updated_at: Date.now(),
        });
        return;
      }

      // 现有的也是 explicit → 拒绝覆盖
      if (existing.source === 'explicit') {
        return;
      }

      // inferred + inferred: 同值加置信度, 冲突降置信度
      let nextConfidence: number;
      try {
        const existingValue = readValue(existing.value);
        const sameValue = JSON.stringify(existingValue) === rawValue;
        nextConfidence = sameValue
          ? Math.min(1.0, existing.confidence + 0.2)
          : Math.max(0.0, existing.confidence - 0.7);
      } catch {
        // 解析失败 → 视为新值
        nextConfidence = Math.max(0.0, existing.confidence - 0.7);
      }

      insertStmt.run({
        key,
        value: rawValue,
        confidence: nextConfidence,
        source: 'inferred',
        updated_at: Date.now(),
      });
    },

    delete(key) {
      deleteStmt.run(key);
    },

    list() {
      const rows = listStmt.all() as PreferenceRow[];
      let records: PreferenceRecord[] = [];
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = readValue(row.value);
        } catch {
          parsed = undefined;
        }
        records.push({
          key: row.key,
          value: parsed,
          raw: row.value,
          confidence: row.confidence,
          source: row.source as PreferenceSource,
          updatedAt: row.updated_at,
        });
      }
      return records;
    },
  };
}
