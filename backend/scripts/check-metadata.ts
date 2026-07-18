/**
 * check-metadata.ts
 *
 * 灵枢 V2 Spec 2B — 工具元数据 CI 校验脚本
 *
 * 校验:
 *   1) metadata.json 存在 + 能 parse 成 JSON
 *   2) metadata.json 通过 metadata.schema.json (JSON Schema 2020-12)
 *   3) (可选) metadata.json 的 tool 数量 = BUILTIN_TOOLS.length (防止漂移)
 *
 * 退出码: 0 = 通过 / 1 = 失败 (CI fail 用)
 *
 * 运行: `tsx backend/scripts/check-metadata.ts`
 *      或 `npm run check:metadata` (在 backend workspace)
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { BUILTIN_TOOLS } from '../src/tools/builtin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..');
const METADATA_PATH = path.join(BACKEND_ROOT, 'src', 'tools', 'metadata.json');
const SCHEMA_PATH = path.join(BACKEND_ROOT, 'src', 'tools', 'metadata.schema.json');

function fail(msg: string): never {
  console.error(`[check-metadata] FAIL: ${msg}`);
  process.exit(1);
}

function main(): void {
  // 1) 文件存在
  if (!existsSync(METADATA_PATH)) fail(`metadata.json not found at ${METADATA_PATH}`);
  if (!existsSync(SCHEMA_PATH)) fail(`metadata.schema.json not found at ${SCHEMA_PATH}`);

  // 2) parse
  let metadata: unknown;
  let schema: unknown;
  try {
    metadata = JSON.parse(readFileSync(METADATA_PATH, 'utf-8'));
  } catch (e) {
    fail(`metadata.json is not valid JSON: ${(e as Error).message}`);
  }
  try {
    schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  } catch (e) {
    fail(`metadata.schema.json is not valid JSON: ${(e as Error).message}`);
  }

  // 3) ajv 校验
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  let validate: (data: unknown) => boolean;
  try {
    validate = ajv.compile(schema as Parameters<typeof ajv.compile>[0]);
  } catch (e) {
    fail(`schema is not a valid JSON Schema: ${(e as Error).message}`);
  }
  const ok = validate!(metadata);
  if (!ok) {
    console.error('[check-metadata] schema validation errors:');
    for (const err of validate!.errors ?? []) {
      console.error(`  - ${err.instancePath || '<root>'} ${err.message}`);
    }
    fail(`metadata.json does not match metadata.schema.json`);
  }
  console.log(`[check-metadata] OK: metadata.json matches schema (${(validate!.errors ?? []).length === 0 ? '0 errors' : 'with allowed extras'})`);

  // 4) 防漂移: tool 数量必须等于 BUILTIN_TOOLS.length
  const m = metadata as { tools?: unknown[] };
  if (!Array.isArray(m.tools)) fail('metadata.tools is not an array');
  const drift = m.tools.length !== BUILTIN_TOOLS.length;
  if (drift) {
    fail(`drift detected: metadata has ${m.tools.length} tools, but BUILTIN_TOOLS has ${BUILTIN_TOOLS.length}. Run \`npm run gen:metadata\`.`);
  }
  console.log(`[check-metadata] OK: ${m.tools.length} tools match BUILTIN_TOOLS (no drift)`);

  // 5) 防漂移: 工具名集合必须完全一致
  const metaNames = new Set(m.tools.map((t: unknown) => (t as { name: string }).name));
  const builtinNames = new Set(BUILTIN_TOOLS.map(t => t.name));
  for (const n of metaNames) {
    if (!builtinNames.has(n)) fail(`drift: metadata has tool "${n}" but builtin.ts does not`);
  }
  for (const n of builtinNames) {
    if (!metaNames.has(n)) fail(`drift: builtin.ts has tool "${n}" but metadata.json does not`);
  }
  console.log(`[check-metadata] OK: tool names match exactly`);

  console.log(`[check-metadata] ALL PASS — metadata.json is in sync with builtin.ts`);
}

try {
  main();
} catch (e) {
  fail(`unexpected: ${(e as Error).message}`);
}
