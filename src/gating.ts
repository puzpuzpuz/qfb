import { scanForDenyTerms } from "./confidentiality.ts";
import type { TaskArtifact, GitSnapshot } from "./types.ts";

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
   * working-tree diff against base plus untracked file contents. (Scanning the
   * *staged* diff would be empty under the default snapshot policy, where
   * nothing is ever staged.)
   */
  diffText: string;
}

export interface GateResult {
  passed: boolean;
  failures: string[];
  /** True when a failure warrants pausing for a human decision vs. retry. */
  pause: boolean;
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
    failures.push("Session did not complete normally (aborted).");
  }

  if (!input.artifact) {
    failures.push("No typed task handoff artifact found at the expected path.");
  } else {
    if (!input.artifact.summary) failures.push("Artifact has an empty summary.");
    // Tests must have actually run with captured exit codes.
    for (const t of input.artifact.testCommands) {
      if (typeof t.exitCode !== "number") {
        failures.push(`Test "${t.command}" has no captured exit code.`);
      } else if (t.exitCode !== 0) {
        failures.push(`Test "${t.command}" failed (exit ${t.exitCode}).`);
      }
      if (!t.logPath) failures.push(`Test "${t.command}" has no captured log path.`);
    }
    if (input.artifact.status === "DONE" && input.artifact.testCommands.length === 0) {
      failures.push("Claimed DONE but no validation commands ran.");
    }
  }

  // Git branch / checkout identity intact.
  if (input.after.branch !== input.expectedBranch) {
    failures.push(`Branch changed: expected ${input.expectedBranch}, got ${input.after.branch}.`);
  }

  // Submodule state must be consistent and intended.
  if (input.before.submoduleHead !== input.after.submoduleHead) {
    failures.push(
      `Submodule java-questdb-client HEAD changed unexpectedly (${input.before.submoduleHead} -> ${input.after.submoduleHead}).`,
    );
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
  const denyMatches = scanForDenyTerms(
    input.diffText + "\n" + changed.join("\n"),
    input.denyList,
  );
  if (denyMatches.length > 0) {
    for (const m of denyMatches) {
      failures.push(`Confidentiality violation: deny-listed term "${m.term}" appears in changeset.`);
    }
    pause = true;
  }

  return { passed: failures.length === 0, failures, pause };
}
