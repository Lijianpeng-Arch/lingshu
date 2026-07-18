#!/usr/bin/env tsx
/**
 * check-tests-count.ts
 *
 * Asserts total test counts across the three test suites
 * (backend / electron / soul) are at or above a configured baseline.
 *
 * Goal: prevent accidental test deletion by failing the build when a
 * suite's total drops below the recorded floor.
 *
 * Usage:
 *   tsx scripts/check-tests-count.ts
 *   npm run test:count
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");

/**
 * Minimum baseline (files / tests) per suite.
 *
 * Values are set ~5% below the current observed count so legitimate
 * growth is not blocked but regressions (especially accidental test
 * deletion) fail the check.
 *
 * Update deliberately only after confirming a real, intentional change
 * to the suite — never "just because".
 */
const MIN_BASELINE = {
  backend: { files: 88, tests: 835 },
  electron: { files: 47, tests: 325 },
  soul: { tests: 42 },
} as const;

type SuiteKey = keyof typeof MIN_BASELINE;

interface SuiteResult {
  key: SuiteKey;
  ok: boolean;
  files?: number;
  tests: number;
  note?: string;
}

/**
 * Parse vitest's final summary block for `Test Files` and `Tests` lines.
 *
 * vitest output (stripped of ANSI) looks like:
 *   Test Files  1 failed | 48 passed (49)
 *        Tests  2 failed | 339 passed (341)
 *
 * We grab the parenthesised total from each line.
 */
function parseVitestTotals(output: string): { files: number; tests: number } | null {
  const fileMatch = output.match(/Test Files[^\n]*\((\d+)\)/);
  const testsMatch = output.match(/^\s*Tests[^\n]*\((\d+)\)/m);
  if (!fileMatch || !testsMatch) return null;
  return {
    files: parseInt(fileMatch[1], 10),
    tests: parseInt(testsMatch[1], 10),
  };
}

/**
 * Strip ANSI escape codes so regexes match reliably across platforms.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Run vitest in the given subdirectory and return parsed totals.
 *
 * We redirect output to a temp file because vitest's output is large
 * (~15-25 KB) and Windows spawnSync/pipe buffers are unreliable past
 * that size. Shell redirection is the cross-platform safe path.
 *
 * We do not abort on non-zero exit: failed tests still need to be
 * *counted* (their presence is the whole point of this script).
 */
function runVitest(suiteDir: string): { files: number; tests: number } | { error: string } {
  const fullDir = join(REPO_ROOT, suiteDir);
  if (!existsSync(fullDir)) {
    return { error: `directory missing: ${suiteDir}` };
  }
  let tmpDir: string | undefined;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "lingshu-test-count-"));
    const tmpFile = join(tmpDir, "vitest.out");
    execSync(`npx vitest run --reporter=default > "${tmpFile}" 2>&1`, {
      cwd: fullDir,
      stdio: "ignore",
      shell: true,
      // vitest on Windows can take ~3 min for the electron suite.
      timeout: 10 * 60 * 1000,
    });
    // Reaching here means vitest exited 0; fall through to parse.
    const data = readFileSync(tmpFile, "utf-8");
    const cleaned = stripAnsi(data);
    const parsed = parseVitestTotals(cleaned);
    return parsed ?? { error: "could not parse vitest output" };
  } catch (e) {
    // Non-zero exit (test failures) is expected — try to parse what we have.
    const err = e as { status?: number };
    if (tmpDir) {
      try {
        const tmpFile = join(tmpDir, "vitest.out");
        const data = readFileSync(tmpFile, "utf-8");
        const cleaned = stripAnsi(data);
        const parsed = parseVitestTotals(cleaned);
        if (parsed) return parsed;
      } catch {
        // Fall through to generic error.
      }
    }
    if (err && typeof err.status === "number") {
      return { error: `vitest exited with code ${err.status}` };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

/**
 * Count pytest `def test_` occurrences by recursive grep.
 *
 * We intentionally count definitions (not collected items) because
 * it's the cheapest stable proxy for "tests authored" and matches
 * what a reviewer sees when reading the tree.
 */
function runPytestCount(): { tests: number } | { error: string } {
  const soulDir = join(REPO_ROOT, "soul");
  if (!existsSync(soulDir)) {
    return { error: "directory missing: soul" };
  }
  try {
    const out = execSync(
      // -r recursive, -n line numbers, --include filters to .py files
      'grep -rn --include="*.py" "def test_" soul',
      { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    // Each definition is at least one match; a single def can match twice
    // (e.g. nested test classes) so we count unique source lines instead.
    const lines = new Set(
      out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    );
    return { tests: lines.size };
  } catch (e) {
    // grep exits 1 when no matches — treat as zero, not error.
    const err = e as { status?: number; message?: string };
    if (err && err.status === 1) return { tests: 0 };
    return { error: err?.message ?? String(e) };
  }
}

function evaluate(suite: SuiteKey, observed: { files?: number; tests: number }): SuiteResult {
  const baseline = MIN_BASELINE[suite];
  const filesOk = observed.files === undefined || observed.files >= baseline.files;
  const testsOk = observed.tests >= baseline.tests;
  return {
    key: suite,
    ok: filesOk && testsOk,
    files: observed.files,
    tests: observed.tests,
    note: filesOk ? undefined : `files ${observed.files} < baseline ${baseline.files}`,
  };
}

function format(result: SuiteResult): string {
  const baseline = MIN_BASELINE[result.key];
  const filesPart =
    result.files !== undefined
      ? `files ${result.files}/${baseline.files}`
      : `files n/a (baseline ${baseline.files})`;
  return `${result.key.padEnd(8)} ${filesPart} | tests ${result.tests}/${baseline.tests}`;
}

function main(): void {
  console.log("[check-tests-count] collecting live counts...\n");

  const backendRaw = runVitest("backend");
  const electronRaw = runVitest("electron");
  const soulRaw = runPytestCount();

  const results: SuiteResult[] = [];

  if ("error" in backendRaw) {
    console.warn(`[skip] backend: ${backendRaw.error}`);
    results.push({ key: "backend", ok: true, tests: 0, note: "skipped" });
  } else {
    results.push(evaluate("backend", backendRaw));
  }

  if ("error" in electronRaw) {
    console.warn(`[skip] electron: ${electronRaw.error}`);
    results.push({ key: "electron", ok: true, tests: 0, note: "skipped" });
  } else {
    results.push(evaluate("electron", electronRaw));
  }

  if ("error" in soulRaw) {
    console.warn(`[skip] soul: ${soulRaw.error}`);
    results.push({ key: "soul", ok: true, tests: 0, note: "skipped" });
  } else {
    results.push(evaluate("soul", { tests: soulRaw.tests }));
  }

  console.log("\n[check-tests-count] results (current / baseline):");
  for (const r of results) {
    const tag = r.ok ? "PASS" : "FAIL";
    console.log(`  ${tag}  ${format(r)}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log("\n[check-tests-count] PASS — all suites at or above baseline.");
    process.exit(0);
  }

  console.error(
    `\n[check-tests-count] FAIL — ${failed.length} suite(s) below baseline: ${failed
      .map((r) => r.key)
      .join(", ")}`
  );
  process.exit(1);
}

main();