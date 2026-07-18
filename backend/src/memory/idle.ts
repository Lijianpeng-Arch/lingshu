/**
 * Idle memory consolidation — borrowed from 白龙马 (BaiLongma).
 *
 * Three-phase sweep over short-term memories:
 *   1. merge  — drop near-duplicates (same first-50-char prefix)
 *   2. prune  — delete short memories with importance<0.3 untouched for >30d
 *   3. promote — short memories touched >=5 times become long-term
 *
 * Pure function over a MemoryRepo; runs synchronously inside one call.
 */

import type { MemoryRepo } from './repo.js';

export interface IdleConsolidationResult {
  merged: number;
  pruned: number;
  promoted: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const PROMOTE_ACCESS_THRESHOLD = 5;
const PRUNE_IMPORTANCE_THRESHOLD = 0.3;

export async function idleMemoryConsolidation(
  memories: MemoryRepo,
): Promise<IdleConsolidationResult> {
  let merged = 0;
  let pruned = 0;
  let promoted = 0;

  // Phase 1 — merge: drop short memories whose first-50-char content key duplicates an earlier one
  const shorts = memories.list('short', 1000);
  const seen = new Map<string, string>();
  for (const mem of shorts) {
    const key = mem.content.trim().slice(0, 50);
    if (!key) continue;
    const existing = seen.get(key);
    if (existing) {
      memories.delete(mem.id);
      merged++;
    } else {
      seen.set(key, mem.id);
    }
  }

  // Phase 2 — prune: short + low-importance + untouched for 30 days
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  for (const mem of memories.list('short', 1000)) {
    if (mem.importance < PRUNE_IMPORTANCE_THRESHOLD && mem.lastAccessedAt < cutoff) {
      memories.delete(mem.id);
      pruned++;
    }
  }

  // Phase 3 — promote: frequently-touched short → long
  for (const mem of memories.list('short', 1000)) {
    if (mem.accessCount >= PROMOTE_ACCESS_THRESHOLD) {
      memories.promoteToLong(mem.id);
      promoted++;
    }
  }

  return { merged, pruned, promoted };
}