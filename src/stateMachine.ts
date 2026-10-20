import { State } from "./types.ts";
import type { StateName } from "./types.ts";

/** Active phases an orthogonal state may return to on an explicit recovery. */
const RESUMABLE: StateName[] = [
  State.READY,
  State.IMPLEMENTING,
  State.HARDENING_IDENTIFY,
  State.HARDENING_WRITE_TESTS,
  State.HARDENING_FIX_BUGS,
  State.REVIEWING,
];

/**
 * Valid forward transitions. Orthogonal states (paused/blocked/failed/
 * reconciliation) are reachable from any non-terminal state and have explicit
 * recovery exits back to the phase that was interrupted. Hardening stages may
 * loop on themselves for bounded retries. The controller — never the LLM —
 * owns these rules.
 */
const TRANSITIONS: Record<StateName, StateName[]> = {
  [State.CREATED]: [State.PREPARING],
  [State.PREPARING]: [State.AWAITING_APPROVAL],
  [State.AWAITING_APPROVAL]: [State.READY],
  [State.READY]: [State.IMPLEMENTING, State.HARDENING_IDENTIFY, State.REVIEWING],
  [State.IMPLEMENTING]: [State.VERIFYING_STEP, State.HARDENING_IDENTIFY],
  [State.VERIFYING_STEP]: [State.CHECKPOINTING, State.IMPLEMENTING],
  [State.CHECKPOINTING]: [State.IMPLEMENTING, State.HARDENING_IDENTIFY],
  [State.HARDENING_IDENTIFY]: [State.HARDENING_IDENTIFY, State.HARDENING_WRITE_TESTS],
  [State.HARDENING_WRITE_TESTS]: [State.HARDENING_WRITE_TESTS, State.HARDENING_FIX_BUGS, State.REVIEWING],
  [State.HARDENING_FIX_BUGS]: [State.HARDENING_FIX_BUGS, State.HARDENING_IDENTIFY, State.REVIEWING],
  [State.REVIEWING]: [State.FIXING, State.COMPLETED],
  [State.FIXING]: [State.VERIFYING_FIX],
  [State.VERIFYING_FIX]: [State.REVIEWING],
  [State.COMPLETED]: [],
  [State.PAUSED]: RESUMABLE,
  [State.BLOCKED]: RESUMABLE,
  [State.FAILED]: RESUMABLE,
  [State.RECONCILIATION]: RESUMABLE,
};

const ORTHOGONAL: StateName[] = [
  State.PAUSED,
  State.BLOCKED,
  State.FAILED,
  State.RECONCILIATION,
];

/** Post-approval lifecycle states in which the controller does work. */
const ACTIVE: StateName[] = [
  State.READY,
  State.IMPLEMENTING,
  State.VERIFYING_STEP,
  State.CHECKPOINTING,
  State.HARDENING_IDENTIFY,
  State.HARDENING_WRITE_TESTS,
  State.HARDENING_FIX_BUGS,
  State.REVIEWING,
  State.FIXING,
  State.VERIFYING_FIX,
];

export function isOrthogonal(s: StateName): boolean {
  return ORTHOGONAL.includes(s);
}

export function isActive(s: StateName): boolean {
  return ACTIVE.includes(s);
}

/**
 * The phase a run returns to when it leaves an orthogonal state after being
 * interrupted in `s`. Intra-step states collapse to their owning phase; a
 * pause anywhere in the review/fix loop re-reviews the current candidate.
 */
export function resumeTarget(s: StateName): StateName {
  switch (s) {
    case State.IMPLEMENTING:
    case State.VERIFYING_STEP:
    case State.CHECKPOINTING:
      return State.IMPLEMENTING;
    case State.HARDENING_IDENTIFY:
    case State.HARDENING_WRITE_TESTS:
    case State.HARDENING_FIX_BUGS:
      return s;
    case State.REVIEWING:
    case State.FIXING:
    case State.VERIFYING_FIX:
      return State.REVIEWING;
    default:
      return State.READY;
  }
}

/**
 * Returns true if `to` is a legal successor of `from`.
 * Any non-terminal state may enter a (different) orthogonal state.
 */
export function canTransition(from: StateName, to: StateName): boolean {
  if (from === State.COMPLETED) return false;
  if (isOrthogonal(to)) return from !== to;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: StateName, to: StateName): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}
