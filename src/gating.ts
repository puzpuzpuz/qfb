import { scanForDenyTerms } from "./confidentiality.ts";
import { AgentStatus } from "./types.ts";
import type { TaskArtifact, GitSnapshot, VerifiedTest } from "./types.ts";

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
   * Authoritative diff content to scan for confidentiality leaks: the
   * working-tree diff against base plus untracked file contents.
   */
  diffText: string;
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
}

/**
 * Validate the on-disk artifact's shape. Anything malformed is treated as "no
 * valid artifact" (a gate failure) instead of crashing the controller.
 */
export function validateArtifact(x: unknown): TaskArtifact | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const a = x as Record<string, unknown>;
  if (!Object.values(AgentStatus).includes(a.status as never)) return null;
  const list = (v: unknown): unknown[] | null => (v === undefined || v === null ? [] : Array.isArray(v) ? v : null);
  const testCommands = list(a.testCommands);
  const changedFiles = list(a.changedFiles);
  const limitations = list(a.limitations);
  const notableDecisions = list(a.notableDecisions);
  const bugs = list(a.bugs);
  if (!testCommands || !changedFiles || !limitations || !notableDecisions || !bugs) return null;
  for (const t of testCommands) {
    const o = t as Record<string, unknown> | null;
    if (!o || typeof o.command !== "string" || !o.command.trim() || typeof o.exitCode !== "number") return null;
  }
  for (const b of bugs) {
    const o = b as Record<string, unknown> | null;
    if (!o || typeof o.id !== "string" || !o.id) return null;
  }
  return {
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
    failures.push("No valid typed task handoff artifact found at the expected path.");
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
    return { passed: failures.length === 0, failures, pause };
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

  // Confidentiality deny-list (Section 7.1): scan the real working-tree diff
  // content (plus untracked file contents) and the git-derived changed names.
  const denyMatches = scanForDenyTerms(input.diffText + "\n" + changed.join("\n"), input.denyList);
  if (denyMatches.length > 0) {
    for (const m of denyMatches) {
      failures.push(`Confidentiality violation: deny-listed term "${m.term}" appears in changeset.`);
    }
    pause = true;
  }

  return { passed: failures.length === 0, failures, pause };
}
