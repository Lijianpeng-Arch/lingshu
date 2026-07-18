/**
 * Provider Config Repository — persists Provider configs to SQLite.
 *
 * Provider api keys are encrypted at rest using AES-256-GCM (see util/crypto.ts).
 * Write path: encryptSecret(apiKey) before INSERT.
 * Read path: decryptSecret(api_key) after SELECT — unless the stored value is
 *   plaintext (legacy rows before the encryption rollout). We detect that case
 *   via the `enc:v1:` prefix and migrate lazily on next upsert.
 */
import type { Database as Db } from 'better-sqlite3';
import type { ProviderConfig, Capability } from '../providers/types.js';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../util/crypto.js';

interface ProviderRow {
  name: string; api_key: string; base_url: string; capabilities: string;
  models: string | null; probe_model: string | null; timeout_ms: number;
  extra_headers: string | null; last_error: string | null;
}

function rowToConfig(row: ProviderRow): ProviderConfig {
  const apiKey = isEncryptedSecret(row.api_key)
    ? decryptSecret(row.api_key)
    : row.api_key;
  return {
    name: row.name, apiKey, baseURL: row.base_url,
    capabilities: JSON.parse(row.capabilities) as Capability[],
    models: row.models ? JSON.parse(row.models) as Record<string, string> : undefined,
    probeModel: row.probe_model ?? undefined, timeoutMs: row.timeout_ms,
    extraHeaders: row.extra_headers ? JSON.parse(row.extra_headers) as Record<string, string> : undefined,
  };
}

export interface ConfigRepo {
  upsertProvider(config: ProviderConfig): void;
  getProvider(name: string): ProviderConfig | undefined;
  listProviders(): ProviderConfig[];
  deleteProvider(name: string): boolean;
  setLastError(name: string, errorJson: string | null): void;
}

export function createConfigRepo(db: Db): ConfigRepo {
  const upsert = db.prepare(`INSERT INTO providers
    (name, api_key, base_url, capabilities, models, probe_model, timeout_ms, extra_headers, created_at, updated_at)
    VALUES (@name, @api_key, @base_url, @capabilities, @models, @probe_model, @timeout_ms, @extra_headers, @now, @now)
    ON CONFLICT(name) DO UPDATE SET
      api_key=excluded.api_key, base_url=excluded.base_url, capabilities=excluded.capabilities,
      models=excluded.models, probe_model=excluded.probe_model, timeout_ms=excluded.timeout_ms,
      extra_headers=excluded.extra_headers, updated_at=excluded.updated_at`);
  const get = db.prepare('SELECT * FROM providers WHERE name = ?');
  const list = db.prepare('SELECT * FROM providers ORDER BY name');
  const del = db.prepare('DELETE FROM providers WHERE name = ?');
  const setErr = db.prepare('UPDATE providers SET last_error = ?, updated_at = ? WHERE name = ?');

  return {
    upsertProvider(config) {
      upsert.run({
        name: config.name, api_key: encryptSecret(config.apiKey), base_url: config.baseURL,
        capabilities: JSON.stringify(config.capabilities),
        models: config.models ? JSON.stringify(config.models) : null,
        probe_model: config.probeModel ?? null, timeout_ms: config.timeoutMs ?? 15_000,
        extra_headers: config.extraHeaders ? JSON.stringify(config.extraHeaders) : null,
        now: Date.now(),
      });
    },
    getProvider(name) { const row = get.get(name) as ProviderRow | undefined; return row ? rowToConfig(row) : undefined; },
    listProviders() { return (list.all() as ProviderRow[]).map(rowToConfig); },
    deleteProvider(name) { return del.run(name).changes > 0; },
    setLastError(name, errorJson) { setErr.run(errorJson, Date.now(), name); },
  };
}
