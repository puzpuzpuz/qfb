import { State } from "./types.ts";
import type { StateName } from "./types.ts";

/**
 * Valid forward transitions. Orthogonal states (paused/blocked/failed/
 * reconciliation) are reachable from any active state and have explicit,
 * restricted exits. The controller — never the LLM — owns these rules.
 */
const TRANSITIONS: Record<StateName, StateName[]> = {
  [State.CREATED]: [State.PREPARING],
  [State.PREPARING]: [State.AWAITING_APPROVAL],
  [State.AWAITING_APPROVAL]: [State.READY],
  [State.READY]: [State.IMPLEMENTING, State.HARDENING_IDENTIFY, State.REVIEWING],
  [State.IMPLEMENTING]: [State.VERIFYING_STEP, State.HARDENING_IDENTIFY],
  [State.VERIFYING_STEP]: [State.CHECKPOINTING, State.IMPLEMENTING],
  [State.CHECKPOINTING]: [State.IMPLEMENTING, State.HARDENING_IDENTIFY],
  [State.HARDENING_IDENTIFY]: [State.HARDENING_WRITE_TESTS],
  [State.HARDENING_WRITE_TESTS]: [State.HARDENING_FIX_BUGS],
  [State.HARDENING_FIX_BUGS]: [State.HARDENING_IDENTIFY, State.REVIEWING],
  [State.REVIEWING]: [State.FIXING, State.COMPLETED],
  [State.FIXING]: [State.VERIFYING_FIX],
  [State.VERIFYING_FIX]: [State.REVIEWING],
  [State.COMPLETED]: [],
  // Orthogonal states: reachable from anywhere (validated separately), with
  // explicit recovery exits.
  [State.PAUSED]: [State.READY, State.IMPLEMENTING, State.HARDENING_IDENTIFY, State.REVIEWING],
  [State.BLOCKED]: [State.IMPLEMENTING, State.HARDENING_FIX_BUGS, State.REVIEWING, State.FAILED],
  [State.FAILED]: [],
  [State.RECONCILIATION]: [State.IMPLEMENTING, State.HARDENING_IDENTIFY, State.REVIEWING, State.READY],
};

const ORTHOGONAL: StateName[] = [
  State.PAUSED,
  State.BLOCKED,
  State.FAILED,
  State.RECONCILIATION,
];

export function isOrthogonal(s: StateName): boolean {
  return ORTHOGONAL.includes(s);
}

/**
 * Returns true if `to` is a legal successor of `from`.
 * Any active (non-terminal) state may enter an orthogonal state.
 */
export function canTransition(from: StateName, to: StateName): boolean {
  if (from === to) return false;
  // Entering an orthogonal state is allowed from any non-terminal state.
  if (isOrthogonal(to) && from !== State.COMPLETED && from !== State.FAILED) {
    return true;
  }
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: StateName, to: StateName): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}
