/**
 * Centralised magic numbers for tool limits, timeouts, and concurrency.
 *
 * Borrowed from Hermes / OpenCode "single source of truth for tunables" pattern.
 * If you find yourself reaching for a bare numeric literal in a tool handler,
 * add it here and import instead.
 */

export const TOOL_LIMITS = {
  READ_MAX_BYTES: 5_000_000,
  READ_DEFAULT_LIMIT: 100_000,
  HEAD_BYTES: 20_000,
  TAIL_BYTES: 20_000,
  GREP_MAX_OUTPUT_BYTES: 5_000_000,
  EDIT_MAX_BYTES: 5 * 1024 * 1024,
} as const;

export const TIMEOUTS = {
  DEFAULT_RUN_COMMAND_MS: 60_000,
  LONG_RUNNING_THRESHOLD_MS: 300_000,
  GREP_DEFAULT_MS: 30_000,
  MAX_GOAL_ITERATIONS: 200,
  PERMISSION_DEFAULT_SECONDS: 60,
} as const;

export const CONCURRENCY = {
  SUB_AGENT_MAX: 8,
} as const;
