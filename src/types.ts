/**
 * Core domain types for QFB.
 *
 * We deliberately avoid TypeScript `enum`s (which require code transformation)
 * so the sources run directly under Node's type-stripping loader.
 */

/** Lifecycle states owned by the durable controller (Section 14). */
export const State = {
  CREATED: "CREATED",
  PREPARING: "PREPARING",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  READY: "READY",
  IMPLEMENTING: "IMPLEMENTING",
  VERIFYING_STEP: "VERIFYING_STEP",
  CHECKPOINTING: "CHECKPOINTING",
  HARDENING_IDENTIFY: "HARDENING_IDENTIFY",
  HARDENING_WRITE_TESTS: "HARDENING_WRITE_TESTS",
  HARDENING_FIX_BUGS: "HARDENING_FIX_BUGS",
  REVIEWING: "REVIEWING",
  FIXING: "FIXING",
  VERIFYING_FIX: "VERIFYING_FIX",
  COMPLETED: "COMPLETED",
  // Orthogonal states
  PAUSED: "paused",
  BLOCKED: "blocked",
  FAILED: "failed",
  RECONCILIATION: "reconciliation",
} as const;

export type StateName = (typeof State)[keyof typeof State];

/** Status a Pi session claims on completion (Section 6). Claims, not trusted results. */
export const AgentStatus = {
  DONE: "DONE",
  BLOCKED: "BLOCKED",
  NEEDS_DECISION: "NEEDS_DECISION",
  FAILED: "FAILED",
} as const;

export type AgentStatusName = (typeof AgentStatus)[keyof typeof AgentStatus];

/** Distinct outcomes of QuestDB's fix-pr skill (Section 3). Only Clean advances. */
export const FixOutcome = {
  CLEAN: "Clean",
  BLOCKED: "Blocked",
  DIVERGING: "Diverging",
  EXHAUSTED: "Exhausted",
} as const;

export type FixOutcomeName = (typeof FixOutcome)[keyof typeof FixOutcome];

/** Review verdict surface (Section 8.1). */
export const Verdict = {
  APPROVED: "approved",
  BLOCKING: "blocking",
  NEEDS_DISCUSSION: "needs-discussion",
} as const;

export type VerdictName = (typeof Verdict)[keyof typeof Verdict];

export const Severity = {
  CRITICAL: "critical",
  MODERATE: "moderate",
  MINOR: "minor",
  ADJACENT: "adjacent",
} as const;

export type SeverityName = (typeof Severity)[keyof typeof Severity];

export interface PlanStep {
  /** Stable identifier, e.g. "S1". */
  id: string;
  /** 1-based ordinal within the frozen manifest. */
  ordinal: number;
  /** Original wording preserved verbatim. */
  text: string;
  /** Status tracked in the store, not in the design doc. */
  status: "pending" | "active" | "done" | "blocked" | "failed";
}

export interface RunConfig {
  maxImplAttemptsPerStep: number;
  maxReviewIterations: number;
  maxInfraRetries: number;
  /** Identify/write-test passes over the cumulative diff (outer hardening loop). */
  maxHardeningGapPasses: number;
  /** Attempts per hardening identify / write-tests stage within one pass. */
  maxHardeningTestAttempts: number;
  /** Bug-fix sessions per hardening pass before the run stops. */
  maxHardeningFixIterations: number;
  maxNoProgress: number;
  /** Mandatory hard ceiling on total Pi sessions per run (Section 11). */
  maxTotalSessions: number;
  sessionInactivityTimeoutMs: number;
  /** Wall-clock limit for each test command the controller re-runs itself. */
  testTimeoutMs: number;
  reviewLevel: 0 | 1 | 2 | 3;
  checkpointPolicy: "snapshot" | "commit";
  /** Resolve all actionable findings, not just Critical (Section 8). */
  strictReviewPolicy: boolean;
  /** Backend selected by Milestone 0 feasibility check. */
  backend: "rpc" | "herdr";
}

export const DEFAULT_CONFIG: RunConfig = {
  maxImplAttemptsPerStep: 3,
  maxReviewIterations: 5,
  maxInfraRetries: 3,
  maxHardeningGapPasses: 2,
  maxHardeningTestAttempts: 3,
  maxHardeningFixIterations: 3,
  maxNoProgress: 2,
  maxTotalSessions: 200,
  sessionInactivityTimeoutMs: 30 * 60 * 1000,
  testTimeoutMs: 2 * 60 * 60 * 1000,
  reviewLevel: 2,
  checkpointPolicy: "snapshot",
  strictReviewPolicy: false,
  backend: "rpc",
};

/** Minimum value of each numeric setting (all must be integers). */
const NUMERIC_MIN: Record<string, number> = {
  maxImplAttemptsPerStep: 1,
  maxReviewIterations: 1,
  maxInfraRetries: 0,
  maxHardeningGapPasses: 1,
  maxHardeningTestAttempts: 1,
  maxHardeningFixIterations: 1,
  // "The same identity survived N consecutive attempts": N = 1 would stop on the first finding.
  maxNoProgress: 2,
  maxTotalSessions: 1,
  sessionInactivityTimeoutMs: 1000,
  testTimeoutMs: 1000,
};

/** Reject unknown keys and out-of-range values instead of letting NaN or 0 silently disable a budget. */
export function validateConfig(config: Record<string, unknown>): asserts config is Record<string, unknown> & RunConfig {
  const errors: string[] = [];
  for (const key of Object.keys(config)) {
    if (!(key in DEFAULT_CONFIG)) errors.push(`unknown setting "${key}"`);
  }
  for (const [key, min] of Object.entries(NUMERIC_MIN)) {
    const v = config[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
      errors.push(`${key} must be an integer >= ${min} (got ${JSON.stringify(v)})`);
    }
  }
  if (![0, 1, 2, 3].includes(config.reviewLevel as number)) {
    errors.push(`reviewLevel must be 0, 1, 2 or 3 (got ${JSON.stringify(config.reviewLevel)})`);
  }
  if (config.checkpointPolicy !== "snapshot" && config.checkpointPolicy !== "commit") {
    errors.push(`checkpointPolicy must be "snapshot" or "commit" (got ${JSON.stringify(config.checkpointPolicy)})`);
  }
  if (typeof config.strictReviewPolicy !== "boolean") {
    errors.push(`strictReviewPolicy must be a boolean (got ${JSON.stringify(config.strictReviewPolicy)})`);
  }
  if (config.backend !== "rpc" && config.backend !== "herdr") {
    errors.push(`backend must be "rpc" or "herdr" (got ${JSON.stringify(config.backend)})`);
  }
  if (errors.length > 0) throw new Error(`Invalid run configuration: ${errors.join("; ")}.`);
}

export interface GitSnapshot {
  branch: string;
  head: string;
  /** Digest of tracked diff against base plus untracked content fingerprint. */
  dirtyFingerprint: string;
  submoduleHead: string | null;
  untrackedFiles: string[];
}

/** A changed file whose content the confidentiality scan cannot read; the gate fails closed on it. */
export interface UnscannableFile {
  path: string;
  /** Why it could not be scanned, e.g. "binary" or "too large (80 MiB)". */
  reason: string;
  /** Content digest, so an operator's "vetted" decision covers exactly this content. */
  digest: string;
}

/**
 * What the confidentiality gate scans: only content the change ADDS versus the
 * feature base. Removed and unchanged lines are excluded, so a pre-existing
 * occurrence that the change deletes or merely surrounds never pauses the run.
 */
export interface AddedContent {
  /** Every added/modified tracked path and every untracked file, with the text the change adds to it. */
  files: { path: string; added: string }[];
  unscannable: UnscannableFile[];
}

/** A question an agent cannot answer itself (status NEEDS_DECISION). */
export interface DecisionRequest {
  question: string;
  /** Concrete alternatives, if the agent sees any. */
  options: string[];
  /** 0-based index into `options` of the agent's recommendation. */
  recommended: number | null;
  /** Why the choice matters: what in the design or code forces it. */
  context: string;
}

/** Typed handoff artifact every session must emit on disk (Section 6). */
export interface TaskArtifact {
  runId: string;
  stepId: string;
  kind: "implementation" | "coverage-gap" | "bug" | "review" | "fix" | "design";
  status: AgentStatusName;
  summary: string;
  changedFiles: string[];
  testCommands: TestRun[];
  limitations: string[];
  /** Implementation-detail decisions the agent made autonomously (Section 2). */
  notableDecisions: string[];
  createdAt: string;
  /** For kind=review: path to the preserved raw review-pr report. */
  reviewReportPath?: string;
  /** For kind=fix: the fix-pr skill's distinct outcome. */
  fixOutcome?: FixOutcomeName;
  /** For kind=bug: bug-handoff entries this session recorded. */
  bugs?: BugEntry[];
  /** Optional detailed handoff document (coverage-gap / bug report) outside the checkout. */
  handoffPath?: string;
  /** With status NEEDS_DECISION: the question for the operator. */
  decision?: DecisionRequest;
}

/** What a gate problem is about, so the CLI can explain it and check that it was fixed. */
export type ProblemCode =
  | "session-aborted"
  | "no-artifact"
  | "empty-summary"
  | "no-tests"
  | "tests-not-rerun"
  | "claim-mismatch"
  | "test-failed"
  | "branch-changed"
  | "head-moved"
  | "submodule-moved"
  | "read-only-modified"
  | "orchestration-doc"
  | "out-of-scope"
  | "deny-term"
  | "unscannable";

export interface GateProblem {
  code: ProblemCode;
  message: string;
  /** Only a person can resolve it (the run pauses); otherwise a fresh attempt may. */
  human: boolean;
  /** Paths concerned, for problems about specific files. */
  files?: string[];
  /** What it should be and what it was: branch, HEAD, submodule HEAD, or tree fingerprint. */
  expected?: string | null;
  actual?: string | null;
  /** The deny-listed term, for `deny-term`. */
  term?: string;
}

/** Why a run stopped, in a form the CLI can explain and help resolve. */
export type Blocker =
  | {
      kind: "decision";
      /** agent: NEEDS_DECISION; blocked: agent claimed BLOCKED; review: needs-discussion; remediation: review unfixable. */
      source: "agent" | "blocked" | "review" | "remediation";
      stage: string;
      stepId: string;
      question: string;
      options: string[];
      recommended: number | null;
      context: string;
      /** Where to read more: the session's artifact or the review report. */
      evidencePath: string | null;
    }
  | { kind: "gate"; stage: string; stepId: string; problems: GateProblem[] }
  | { kind: "unscannable"; files: UnscannableFile[] }
  | { kind: "design-changed" }
  | { kind: "design-missing"; path: string }
  | { kind: "session-running"; sessionId: string; pid: number | null; host: string | null }
  | { kind: "interrupted"; evidence: string[] }
  | { kind: "operator-pause" }
  | { kind: "git-error"; message: string }
  | { kind: "review"; detail: string; reportPath: string | null }
  | { kind: "stale"; detail: string }
  | { kind: "regression"; failing: { command: string; exitCode: number; logPath: string }[]; suitePath: string }
  | { kind: "budget"; detail: string; stepId: string | null };

/** An operator's answer, recorded for the run and given to every later session. */
export interface Decision {
  id: number;
  stage: string;
  stepId: string;
  question: string;
  answer: string;
  /** The design document was revised to match. */
  designRevised: boolean;
  createdAt: string;
}

export interface BugEntry {
  id: string;
  location: string;
  repro: string;
  failingTest: string;
  observed: string;
  expected: string;
}

/** A validation command as CLAIMED by the agent. Never trusted on its own. */
export interface TestRun {
  command: string;
  exitCode: number;
  logPath?: string;
  /**
   * Not a lasting test: a check of behavior the plan will change (a baseline
   * repro) or a throwaway diagnostic. Re-run and gated when claimed like any
   * command, but kept out of the regression suite re-run on the final candidate.
   */
  oneOff?: boolean;
}

/** A claimed validation command re-run by the controller, with its REAL exit code. */
export interface VerifiedTest {
  command: string;
  claimedExitCode: number;
  exitCode: number;
  logPath: string;
  /** The agent marked it a one-off check (see TestRun.oneOff). */
  oneOff?: boolean;
}

export interface Finding {
  id: string;
  severity: SeverityName;
  location: string;
  evidence: string;
}

export interface ReviewReport {
  verdict: VerdictName;
  findings: Finding[];
  testGatePassed: boolean;
  raw: string;
}
