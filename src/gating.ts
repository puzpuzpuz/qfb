import { effectiveTerms, scanForDenyTerms } from "./confidentiality.ts";
import { AgentStatus } from "./types.ts";
import type { AddedContent, TaskArtifact, GitSnapshot, UnscannableFile, VerifiedTest } from "./types.ts";

/**
 * Orchestration-artifact hygiene (Section 7.1): spec/handoff files must never
 * be staged, committed, or added to .gitignore in the QuestDB checkout.
 */
const FORBIDDEN_PATHS = [
  /(^|\/)\.qfb(\/|$)/i,
  /qfb[-_]?state/i,
  /handoff/i,
  /coverage[-_]?gap/i,
  /\.gitignore$/,
];

export interface GateInput {
  /**
   * `writer`: the session may change product code/tests (implementation,
   * hardening write/fix, fix-pr). `read-only`: the session must leave the
   * checkout byte-for-byte unchanged (coverage-gap identification, review).
   */
  mode: "writer" | "read-only";
  artifact: TaskArtifact | null;
  /** Why the artifact was rejected (shape or identity), when known. */
  artifactProblem?: string | null;
  /** Whether the Pi session completed normally (not aborted). */
  sessionCompleted: boolean;
  before: GitSnapshot;
  after: GitSnapshot;
  expectedBranch: string;
  /** Files the step is permitted to touch; empty means "any product file". */
  allowedPathPrefixes: string[];
  /** Frozen confidentiality deny-list. */
  denyList: string[];
  /**
   * Authoritative, git-derived list of paths changed in the working tree
   * versus the feature base (tracked modifications + untracked files). This is
   * computed by the controller from git itself — NOT taken from the agent's
   * self-reported `artifact.changedFiles` — so scope and confidentiality are
   * gated on evidence QFB can verify.
   */
  changedFiles: string[];
  /**
   * Authoritative, git-derived content the change ADDS versus the feature base
   * (added lines plus untracked file contents), scanned for deny-listed terms.
   * Files that could not be scanned make the gate fail closed. Ignored in
   * read-only mode.
   */
  added: AddedContent;
  /**
   * The artifact's claimed validation commands, re-run by the controller with
   * their REAL exit codes. The gate decides on these, never on the claim.
   */
  verifiedTests: VerifiedTest[];
  /**
   * Hardening write/fix stages: a failing test is legitimate evidence (not a
   * gate failure) iff the artifact records the bug(s) it exposes.
   */
  allowFailingTestsWithBugs?: boolean;
}

export interface GateResult {
  passed: boolean;
  failures: string[];
  /** True when a failure warrants pausing for a human decision vs. retry. */
  pause: boolean;
  /** Changed files the confidentiality scan could not read (each is also listed in `failures`). */
  unscannable: UnscannableFile[];
  /**
   * True when the ONLY failures are unscannable files: the result is otherwise
   * acceptable, so it can be re-gated once an operator has vetted them.
   */
  vetOnly: boolean;
}

/** Who an artifact must belong to: the session that was asked to write it. */
export interface ExpectedArtifact {
  runId: string;
  stepId: string;
  kind: TaskArtifact["kind"];
  /** Session start (ISO). An artifact created before it is a leftover, not this session's. */
  startedAt: string;
}

/**
 * Clock tolerance for `createdAt`: agents often write second-precision
 * timestamps, so an artifact written in the session's first second can appear
 * slightly older than the millisecond-precision session start.
 */
const CREATED_AT_SLACK_MS = 5_000;

export type ArtifactCheck = { artifact: TaskArtifact; problem: null } | { artifact: null; problem: string };

/** `checkArtifact(...).artifact`: the validated artifact, or null for "no valid artifact". */
export function validateArtifact(x: unknown, expected?: ExpectedArtifact): TaskArtifact | null {
  return checkArtifact(x, expected).artifact;
}

/**
 * Validate the on-disk artifact's shape and, when `expected` is given, that it
 * belongs to this session (run, step, kind, and not created before the session
 * started). Anything malformed or foreign is "no valid artifact" (a gate
 * failure, with the reason) instead of crashing the controller.
 */
export function checkArtifact(x: unknown, expected?: ExpectedArtifact): ArtifactCheck {
  const bad = (problem: string): ArtifactCheck => ({ artifact: null, problem });
  if (x === null || x === undefined) return bad("none was written, or it is not valid JSON");
  if (typeof x !== "object" || Array.isArray(x)) return bad("the artifact is not a JSON object");
  const a = x as Record<string, unknown>;
  if (!Object.values(AgentStatus).includes(a.status as never)) return bad(`invalid status ${JSON.stringify(a.status)}`);
  const list = (v: unknown): unknown[] | null => (v === undefined || v === null ? [] : Array.isArray(v) ? v : null);
  const testCommands = list(a.testCommands);
  const changedFiles = list(a.changedFiles);
  const limitations = list(a.limitations);
  const notableDecisions = list(a.notableDecisions);
  const bugs = list(a.bugs);
  if (!testCommands || !changedFiles || !limitations || !notableDecisions || !bugs) {
    return bad("testCommands, changedFiles, limitations, notableDecisions and bugs must be arrays");
  }
  for (const t of testCommands) {
    const o = t as Record<string, unknown> | null;
    if (!o || typeof o.command !== "string" || !o.command.trim() || typeof o.exitCode !== "number") {
      return bad("every testCommands entry needs a non-empty command and a numeric exitCode");
    }
  }
  for (const b of bugs) {
    const o = b as Record<string, unknown> | null;
    if (!o || typeof o.id !== "string" || !o.id) return bad("every bugs entry needs a non-empty id");
  }
  if (expected) {
    for (const k of ["runId", "stepId", "kind"] as const) {
      if (a[k] !== expected[k]) {
        return bad(`${k} is ${JSON.stringify(a[k])}, expected ${JSON.stringify(expected[k])} (an artifact from another session?)`);
      }
    }
    const created = typeof a.createdAt === "string" ? Date.parse(a.createdAt) : NaN;
    if (Number.isNaN(created)) return bad(`createdAt ${JSON.stringify(a.createdAt)} is not an ISO-8601 timestamp`);
    if (created < Date.parse(expected.startedAt) - CREATED_AT_SLACK_MS) {
      return bad(`createdAt ${a.createdAt} predates the session start ${expected.startedAt} (a leftover artifact?)`);
    }
  }
  const artifact: TaskArtifact = {
    ...(a as unknown as TaskArtifact),
    summary: typeof a.summary === "string" ? a.summary : "",
    testCommands: testCommands as TaskArtifact["testCommands"],
    changedFiles: changedFiles as string[],
    limitations: limitations as string[],
    notableDecisions: notableDecisions as string[],
    bugs: (bugs as TaskArtifact["bugs"])!.map((b) => ({
      ...b,
      location: typeof b.location === "string" ? b.location : "",
      repro: typeof b.repro === "string" ? b.repro : "",
    })),
  };
  return { artifact, problem: null };
}

const MAX_LISTED_PATHS = 5;

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(", ");
  return paths.length > MAX_LISTED_PATHS ? `${shown} (+${paths.length - MAX_LISTED_PATHS} more)` : shown;
}

/**
 * Confidentiality check (Section 7.1) over what a change adds: each deny-listed
 * term found in an added/changed file's name or added content, and each file
 * that could not be scanned (fail closed). Nothing to look for, nothing to fail.
 */
export function confidentialityFailures(added: AddedContent, denyList: string[]): string[] {
  if (effectiveTerms(denyList).length === 0) return [];
  const hits = new Map<string, string[]>();
  for (const f of added.files) {
    for (const m of scanForDenyTerms(`${f.path}\n${f.added}`, denyList)) {
      const paths = hits.get(m.term) ?? [];
      paths.push(f.path);
      hits.set(m.term, paths);
    }
  }
  const failures = [...hits].map(
    ([term, paths]) => `Confidentiality violation: deny-listed term "${term}" added in ${listPaths(paths)}.`,
  );
  for (const u of added.unscannable) {
    failures.push(`Cannot check ${u.path} for deny-listed terms (${u.reason}); a human must vet it.`);
  }
  return failures;
}

/**
 * Mechanical gate (Section 6.1): objective facts only. Whether prose acceptance
 * criteria were "met" is explicitly NOT evaluated here — that is delegated to
 * the Phase D review/fix loop.
 */
export function mechanicalGate(input: GateInput): GateResult {
  const failures: string[] = [];
  let pause = false;

  if (!input.sessionCompleted) {
    failures.push("Session did not complete normally (aborted or timed out).");
  }
  if (!input.artifact) {
    failures.push(
      `No valid typed task handoff artifact found at the expected path${input.artifactProblem ? `: ${input.artifactProblem}` : "."}`,
    );
  }

  // Git branch / checkout identity intact — for every kind of session.
  if (input.after.branch !== input.expectedBranch) {
    failures.push(`Branch changed: expected ${input.expectedBranch}, got ${input.after.branch}.`);
    pause = true;
  }
  if (input.before.head !== input.after.head) {
    failures.push(
      `HEAD moved during the session (${input.before.head} -> ${input.after.head}); agents must not commit, reset, or rewrite history.`,
    );
    pause = true;
  }
  if (input.before.submoduleHead !== input.after.submoduleHead) {
    failures.push(
      `Submodule java-questdb-client HEAD changed unexpectedly (${input.before.submoduleHead} -> ${input.after.submoduleHead}).`,
    );
    pause = true;
  }

  if (input.mode === "read-only") {
    if (input.before.dirtyFingerprint !== input.after.dirtyFingerprint) {
      failures.push("Read-only session modified the checkout; its result is stale and cannot be accepted.");
      pause = true;
    }
    return { passed: failures.length === 0, failures, pause, unscannable: [], vetOnly: false };
  }

  // ---- writer mode ----
  const a = input.artifact;
  if (a) {
    if (!a.summary) failures.push("Artifact has an empty summary.");
    if (a.status === AgentStatus.DONE) {
      if (a.testCommands.length === 0) failures.push("Claimed DONE but no validation commands ran.");
      if (input.verifiedTests.length !== a.testCommands.length) {
        failures.push("Not every claimed validation command was re-run by the controller.");
      }
    }
    const failingAllowed = Boolean(input.allowFailingTestsWithBugs) && (a.bugs?.length ?? 0) > 0;
    for (const t of input.verifiedTests) {
      if (t.exitCode !== t.claimedExitCode) {
        failures.push(
          `Artifact claims "${t.command}" exited ${t.claimedExitCode}, but the controller's re-run exited ${t.exitCode} (log: ${t.logPath}).`,
        );
      } else if (t.exitCode !== 0 && !failingAllowed) {
        failures.push(`Test "${t.command}" failed (exit ${t.exitCode}; log: ${t.logPath}).`);
      }
    }
  }

  // Scope: only allowed paths may change. Enumerated from git, not the agent's
  // self-report, so an under-reported changeset cannot slip past the gate.
  const changed = input.changedFiles;
  for (const file of changed) {
    for (const re of FORBIDDEN_PATHS) {
      if (re.test(file)) {
        failures.push(`Forbidden orchestration artifact in changeset: ${file}.`);
        pause = true;
      }
    }
    if (input.allowedPathPrefixes.length > 0) {
      const ok = input.allowedPathPrefixes.some((p) => file.startsWith(p));
      if (!ok) {
        failures.push(`Out-of-scope file change: ${file}.`);
        pause = true;
      }
    }
  }

  // Confidentiality deny-list (Section 7.1): scan what the change really adds
  // (git-derived), failing closed on anything that could not be scanned.
  const otherFailures = failures.length;
  const leaks = confidentialityFailures(input.added, input.denyList);
  if (leaks.length > 0) {
    failures.push(...leaks);
    pause = true;
  }
  const unscannable = effectiveTerms(input.denyList).length > 0 ? input.added.unscannable : [];
  const vetOnly = otherFailures === 0 && unscannable.length > 0 && leaks.length === unscannable.length;

  return { passed: failures.length === 0, failures, pause, unscannable, vetOnly };
}
