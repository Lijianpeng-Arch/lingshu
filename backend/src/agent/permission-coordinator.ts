import type { PermissionDecision } from '../permission/types.js';

/**
 * PermissionCoordinator (Phase C3)
 * ─────────────────────────────────────────────────────────────────────────
 * Extracted from main-loop.ts. Owns the *coordination* of permission
 * requests — the in-flight `pendingPermissions` map, the ask→wait Promise,
 * and the auto-deny-on-timeout logic. It deliberately does NOT own:
 *
 *   - the actual policy decision (that stays in permission/gate.ts, injected
 *     here as the `gate` dependency);
 *   - the AwarenessEvent broadcasting (permission.request / .resolved /
 *     .timeout envelopes) — the caller wires that around gateCall.
 *
 * This keeps the coordinator pure and unit-testable: given a gate function
 * and a timeout, it manages the lifecycle of pending "ask" requests.
 */

/**
 * The injected policy gate. Mirrors permission/gate.ts `evaluate()` shape but
 * pre-bound to the current settings/mode by the caller, so the coordinator
 * only needs (tool, args) to get a decision.
 */
export type PermissionGate = (
  tool: string,
  args: Record<string, unknown>,
) => PermissionDecision;

/** How a pending "ask" request was ultimately resolved. */
export type ResolveDecision = 'allow' | 'deny';

/** Called by the coordinator each time an "ask" request needs a fresh id. */
export type IdFactory = () => string;

export interface PermissionCoordinatorDeps {
  /** The policy gate (pre-bound to current settings). */
  gate: PermissionGate;
  /** Auto-deny timeout for pending "ask" requests, in ms. */
  defaultTimeoutMs: number;
  /**
   * Produces the id used to track a pending request. In main-loop this is the
   * broadcast envelope id; in tests it can be a simple counter. Defaults to a
   * monotonic internal counter when omitted.
   */
  idFactory?: IdFactory;
}

/**
 * Extra context for a single gate call. `bypassConfirm` short-circuits an
 * "ask" decision into an immediate allow. (Removed in Phase D — see gateCall
 * for the resolved behavior.)
 */
export interface GateCallContext {
  bypassConfirm?: boolean;
}

/** A request currently awaiting the user's decision. */
interface PendingRequest {
  resolve: (decision: PermissionDecision) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface GateCallResult {
  /** The final decision (allow / deny). "ask" is never surfaced — it is awaited. */
  decision: PermissionDecision;
  /**
   * When the gate said "ask", this is the pending request id that was
   * registered before the Promise resolved. `null` for immediate allow/deny.
   * Callers use it to broadcast a permission.request envelope keyed by id.
   */
  pendingId: string | null;
}

export interface PermissionCoordinator {
  /**
   * Gate a tool call. Returns an immediate allow/deny, or — when the gate says
   * "ask" — a Promise that resolves once the user responds via
   * `resolveRequest()` or the timeout auto-denies.
   *
   * The returned `pendingId` (for the "ask" path) lets the caller register the
   * request id *before* awaiting, but note the Promise only settles after
   * resolution. Callers that need the id up-front should use the lower-level
   * flow; most callers simply `await coordinator.gateCall(...)`.
   */
  gateCall(
    tool: string,
    args: Record<string, unknown>,
    ctx?: GateCallContext,
  ): Promise<PermissionDecision>;
  /** True if a request with this id is currently pending. */
  pendingRequest(id: string): boolean;
  /** Resolve a pending request. No-ops for unknown / already-resolved ids. */
  resolveRequest(id: string, decision: ResolveDecision, reason?: string): void;
  /** Deny + clear every pending request (used on stop()). */
  cancelAll(reason?: string): void;
  /** Number of currently-pending requests. */
  pendingCount(): number;
}

export function createPermissionCoordinator(
  deps: PermissionCoordinatorDeps,
): PermissionCoordinator {
  const { gate, defaultTimeoutMs } = deps;

  let counter = 0;
  const idFactory: IdFactory = deps.idFactory ?? (() => `perm-${++counter}`);

  const pending = new Map<string, PendingRequest>();

  function finalize(id: string): PendingRequest | undefined {
    const req = pending.get(id);
    if (!req) return undefined;
    clearTimeout(req.timeout);
    pending.delete(id);
    return req;
  }

  async function gateCall(
    tool: string,
    args: Record<string, unknown>,
    ctx: GateCallContext = {},
  ): Promise<PermissionDecision> {
    // bypassConfirm auto-allow was removed in Phase D.
    if (ctx.bypassConfirm === true) {
      return { kind: 'allow' };
    }

    const decision = gate(tool, args);
    if (decision.kind === 'allow' || decision.kind === 'deny') {
      return decision;
    }

    // decision.kind === 'ask' — register a pending request and wait.
    const id = idFactory();
    return new Promise<PermissionDecision>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve({ kind: 'deny', reason: 'timeout' });
      }, defaultTimeoutMs);
      // Don't keep the Node process alive just for this timer.
      if (typeof (timeout as { unref?: () => void }).unref === 'function') {
        (timeout as { unref: () => void }).unref();
      }
      pending.set(id, { resolve, reject, timeout });
    });
  }

  function pendingRequest(id: string): boolean {
    return pending.has(id);
  }

  function resolveRequest(id: string, decision: ResolveDecision, reason?: string): void {
    const req = finalize(id);
    if (!req) return; // unknown / already-resolved — silently ignore
    if (decision === 'allow') {
      req.resolve({ kind: 'allow' });
    } else {
      req.resolve({ kind: 'deny', reason: reason ?? 'Denied by user' });
    }
  }

  function cancelAll(reason?: string): void {
    for (const id of [...pending.keys()]) {
      const req = finalize(id);
      req?.resolve({ kind: 'deny', reason: reason ?? 'stopped' });
    }
  }

  function pendingCount(): number {
    return pending.size;
  }

  return { gateCall, pendingRequest, resolveRequest, cancelAll, pendingCount };
}
