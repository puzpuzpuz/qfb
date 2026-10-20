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

export interface GitSnapshot {
  branch: string;
  head: string;
  /** Digest of tracked diff against base plus untracked content fingerprint. */
  dirtyFingerprint: string;
  submoduleHead: string | null;
  untrackedFiles: string[];
}

/** Typed handoff artifact every session must emit on disk (Section 6). */
export interface TaskArtifact {
  runId: string;
  stepId: string;
  kind: "implementation" | "coverage-gap" | "bug" | "review" | "fix";
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
}

/** A claimed validation command re-run by the controller, with its REAL exit code. */
export interface VerifiedTest {
  command: string;
  claimedExitCode: number;
  exitCode: number;
  logPath: string;
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
