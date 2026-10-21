import { effectiveTerms, scanForDenyTerms } from "./confidentiality.ts";
import { AgentStatus } from "./types.ts";
import type {
  AddedContent,
  DecisionRequest,
  GateProblem,
  TaskArtifact,
  GitSnapshot,
  UnscannableFile,
  VerifiedTest,
} from "./types.ts";

/**
 * Orchestration-artifact hygiene (Section 7.1): QFB state, orchestration notes
 * (handoff, decision, coverage-gap documents) and .gitignore edits must never
 * enter the change set. Notes are matched by file name and document extension,
 * so product code that merely mentions a handoff (HandoffQueue.java) passes.
 * The run's own design document and any doc the operator kept local are
 * excluded from the change set before this check (see Git's `exclude`).
 */
const FORBIDDEN_PATHS = [
  /(^|\/)\.qfb(\/|$)/i,
  /qfb[-_]?state/i,
  /(^|\/)[^/]*(handoff|decision|coverage[-_]?gaps?)[^/]*\.(md|markdown|txt)$/i,
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
  /** `problems` as text. */
  failures: string[];
  problems: GateProblem[];
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
    decision: normalizeDecision(a.decision),
  };
  return { artifact, problem: null };
}

/** A usable decision request, or undefined: a malformed one is dropped, and the summary says what is needed. */
function normalizeDecision(x: unknown): DecisionRequest | undefined {
  if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
  const d = x as Record<string, unknown>;
  if (typeof d.question !== "string" || !d.question.trim()) return undefined;
  const options = Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === "string" && o.trim() !== "") : [];
  const r = d.recommended;
  const recommended = typeof r === "number" && Number.isInteger(r) && r >= 0 && r < options.length ? r : null;
  return { question: d.question.trim(), options, recommended, context: typeof d.context === "string" ? d.context.trim() : "" };
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
export function confidentialityProblems(added: AddedContent, denyList: string[]): GateProblem[] {
  if (effectiveTerms(denyList).length === 0) return [];
  const hits = new Map<string, string[]>();
  for (const f of added.files) {
    for (const m of scanForDenyTerms(`${f.path}\n${f.added}`, denyList)) {
      const paths = hits.get(m.term) ?? [];
      paths.push(f.path);
      hits.set(m.term, paths);
    }
  }
  const problems: GateProblem[] = [...hits].map(([term, paths]) => ({
    code: "deny-term",
    message: `Confidentiality violation: deny-listed term "${term}" added in ${listPaths(paths)}.`,
    human: true,
    files: paths,
    term,
  }));
  for (const u of added.unscannable) {
    problems.push({
      code: "unscannable",
      message: `Cannot check ${u.path} for deny-listed terms (${u.reason}); a human must vet it.`,
      human: true,
      files: [u.path],
    });
  }
  return problems;
}

export function confidentialityFailures(added: AddedContent, denyList: string[]): string[] {
  return confidentialityProblems(added, denyList).map((p) => p.message);
}

/**
 * Mechanical gate (Section 6.1): objective facts only. Whether prose acceptance
 * criteria were "met" is explicitly NOT evaluated here — that is delegated to
 * the Phase D review/fix loop.
 */
export function mechanicalGate(input: GateInput): GateResult {
  const problems: GateProblem[] = [];
  const add = (code: GateProblem["code"], message: string, human: boolean, extra: Partial<GateProblem> = {}) =>
    problems.push({ code, message, human, ...extra });

  if (!input.sessionCompleted) add("session-aborted", "Session did not complete normally (aborted or timed out).", false);
  if (!input.artifact) {
    add("no-artifact",
      `No valid typed task handoff artifact found at the expected path${input.artifactProblem ? `: ${input.artifactProblem}` : "."}`,
      false);
  }

  // Git branch / checkout identity intact — for every kind of session.
  const { before, after } = input;
  if (after.branch !== input.expectedBranch) {
    add("branch-changed", `Branch changed: expected ${input.expectedBranch}, got ${after.branch}.`, true,
      { expected: input.expectedBranch, actual: after.branch });
  }
  if (before.head !== after.head) {
    add("head-moved",
      `HEAD moved during the session (${before.head} -> ${after.head}); agents must not commit, reset, or rewrite history.`,
      true, { expected: before.head, actual: after.head });
  }
  if (before.submoduleHead !== after.submoduleHead) {
    add("submodule-moved",
      `Submodule java-questdb-client HEAD changed unexpectedly (${before.submoduleHead} -> ${after.submoduleHead}).`,
      true, { expected: before.submoduleHead, actual: after.submoduleHead });
  }

  if (input.mode === "read-only") {
    if (before.dirtyFingerprint !== after.dirtyFingerprint) {
      add("read-only-modified", "Read-only session modified the checkout; its result is stale and cannot be accepted.", true,
        { expected: before.dirtyFingerprint, actual: after.dirtyFingerprint });
    }
    return result(problems, []);
  }

  // ---- writer mode ----
  const a = input.artifact;
  if (a) {
    if (!a.summary) add("empty-summary", "Artifact has an empty summary.", false);
    if (a.status === AgentStatus.DONE) {
      if (a.testCommands.length === 0) add("no-tests", "Claimed DONE but no validation commands ran.", false);
      if (input.verifiedTests.length !== a.testCommands.length) {
        add("tests-not-rerun", "Not every claimed validation command was re-run by the controller.", false);
      }
    }
    const failingAllowed = Boolean(input.allowFailingTestsWithBugs) && (a.bugs?.length ?? 0) > 0;
    for (const t of input.verifiedTests) {
      if (t.exitCode !== t.claimedExitCode) {
        add("claim-mismatch",
          `Artifact claims "${t.command}" exited ${t.claimedExitCode}, but the controller's re-run exited ${t.exitCode} (log: ${t.logPath}).`,
          false);
      } else if (t.exitCode !== 0 && !failingAllowed) {
        add("test-failed", `Test "${t.command}" failed (exit ${t.exitCode}; log: ${t.logPath}).`, false);
      }
    }
  }

  // Scope: only allowed paths may change. Enumerated from git, not the agent's
  // self-report, so an under-reported changeset cannot slip past the gate.
  for (const file of input.changedFiles) {
    if (FORBIDDEN_PATHS.some((re) => re.test(file))) {
      add("orchestration-doc", `Forbidden orchestration artifact in changeset: ${file}.`, true, { files: [file] });
    }
    if (input.allowedPathPrefixes.length > 0 && !input.allowedPathPrefixes.some((p) => file.startsWith(p))) {
      add("out-of-scope", `Out-of-scope file change: ${file}.`, true, { files: [file] });
    }
  }

  // Confidentiality deny-list (Section 7.1): scan what the change really adds
  // (git-derived), failing closed on anything that could not be scanned.
  const otherFailures = problems.length;
  const leaks = confidentialityProblems(input.added, input.denyList);
  problems.push(...leaks);
  const unscannable = effectiveTerms(input.denyList).length > 0 ? input.added.unscannable : [];
  const r = result(problems, unscannable);
  r.vetOnly = otherFailures === 0 && unscannable.length > 0 && leaks.length === unscannable.length;
  return r;
}

function result(problems: GateProblem[], unscannable: UnscannableFile[]): GateResult {
  return {
    passed: problems.length === 0,
    failures: problems.map((p) => p.message),
    problems,
    pause: problems.some((p) => p.human),
    unscannable,
    vetOnly: false,
  };
}
