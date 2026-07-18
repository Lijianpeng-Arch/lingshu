#!/usr/bin/env node
/**
 * Wrapper around electron-vite that:
 *   1. Unsets ELECTRON_RUN_AS_NODE (this dev shell has it = 1 globally,
 *      which forces electron.exe into Node-only mode).
 *   2. Sets LINGSHU_DISABLE_GPU=1 and LINGSHU_DISABLE_SANDBOX=1 so the
 *      main process disables hardware acceleration. The dev environment
 *      has a flaky GPU process that crashes silently, preventing any
 *      window from showing. Disable to fall back to software rendering.
 *
 * Both flags are env-var opt-in: setting LINGSHU_FORCE_GPU=1 keeps
 * the original behavior (in case a developer wants to debug GPU issues).
 */

const { spawn } = require('node:child_process');

const cmd = process.argv[2];
if (!cmd || !['dev', 'build', 'preview'].includes(cmd)) {
  console.error('Usage: node scripts/run-electron-vite.js <dev|build|preview>');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.env.LINGSHU_FORCE_GPU !== '1') {
  env.LINGSHU_DISABLE_GPU = '1';
  env.LINGSHU_DISABLE_SANDBOX = '1';
}

const path = require('node:path');
const electronViteBin = path.resolve(__dirname, '..', '..', 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');

const child = spawn(
  process.execPath,
  [electronViteBin, cmd],
  { stdio: 'inherit', env, cwd: path.resolve(__dirname, '..') }
);

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error('Failed to spawn electron-vite:', err.message);
  process.exit(1);
});