/**
 * Sandbox path guard — shared by all filesystem-touching built-in tools.
 *
 * The sandbox root is read from `LINGSHU_SANDBOX_ROOT` env var on every
 * lookup (no module-level cache), so tests can flip the env in beforeEach
 * without touching module instances.
 *
 * Without this guard (C1 review), write_file/edit_file/delete_file/mkdir/
 * rm/cp/mv could touch any absolute path on the host, which combined with
 * `autonomous` permission mode = one-click RCE.
 */

import * as path from 'node:path';

function readSandboxRoot(): string {
  const fromEnv = process.env['LINGSHU_SANDBOX_ROOT'];
  if (fromEnv && path.isAbsolute(fromEnv)) return path.resolve(fromEnv);
  return path.resolve(process.cwd());
}

export function getSandboxRoot(): string {
  return readSandboxRoot();
}

/**
 * Set the sandbox root. Pass an absolute path. Mainly for tests.
 */
export function setSandboxRoot(p: string): void {
  if (!p || !path.isAbsolute(p)) {
    throw new Error(`setSandboxRoot requires an absolute path, got: ${p}`);
  }
  process.env['LINGSHU_SANDBOX_ROOT'] = path.resolve(p);
}

export function isInsideSandbox(target: string): boolean {
  if (!target) return false;
  const sandboxRoot = readSandboxRoot();
  const resolved = path.resolve(target);
  // Windows path comparison: drive-letter casing and separator style can
  // differ between `process.cwd()` and `path.resolve(target)`. Normalize.
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const rResolved = norm(resolved);
  const rRoot = norm(sandboxRoot);
  return rResolved === rRoot
    || rResolved.startsWith(rRoot + path.sep);
}

export function sandboxViolationError(target: string): { ok: false; error: string } {
  return {
    ok: false,
    error: `Path "${target}" is outside sandbox "${getSandboxRoot()}". Refused.`,
  };
}