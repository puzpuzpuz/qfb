import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../src/git.ts";
import { extractPlan } from "../src/plan.ts";
import { parseReviewReport, selectActionableFindings, isAcceptable, AmbiguousReportError } from "../src/report.ts";
import { detectNoProgress, findingIdentity } from "../src/identity.ts";
import { scanForDenyTerms } from "../src/confidentiality.ts";
import { canTransition, assertTransition, resumeTarget } from "../src/stateMachine.ts";
import { mechanicalGate, validateArtifact } from "../src/gating.ts";
import type { GateInput } from "../src/gating.ts";
import { State } from "../src/types.ts";
import type { GitSnapshot, TaskArtifact, VerifiedTest } from "../src/types.ts";

const snap = (over: Partial<GitSnapshot> = {}): GitSnapshot => ({
  branch: "feature/x",
  head: "h1",
  dirtyFingerprint: "fp",
  submoduleHead: "sub0",
  untrackedFiles: [],
  ...over,
});

const art = (over: Partial<TaskArtifact> = {}): TaskArtifact => ({
  runId: "r",
  stepId: "S1",
  kind: "implementation",
  status: "DONE",
  summary: "ok",
  changedFiles: ["src/Foo.java"],
  testCommands: [{ command: "mvn test", exitCode: 0, logPath: "/tmp/l" }],
  limitations: [],
  notableDecisions: [],
  createdAt: "now",
  ...over,
});

test("plan: extracts ordered numbered steps under Implementation Plan", () => {
  const { steps, ambiguous } = extractPlan(THREE);
  assert.equal(ambiguous, false);
  assert.deepEqual(steps.map((s) => s.id), ["S1", "S2", "S3"]);
  assert.match(steps[0]!.text, /column reader/);
});

test("plan: ambiguous when no steps found", () => {
  const { ambiguous } = extractPlan("# Title\n\nNo plan here, just prose.");
  assert.equal(ambiguous, true);
});

test("plan: extracts heading-delimited '### Step N' steps and preserves wording", () => {
  const doc = `# Handoff

## Implementation plan

Some preamble prose that is not a step.

### Step 0 — baseline (no code)
- Read the templates.
- Confirm the repro.

### Step 1 — add ROWS codec
- Mirror avg's ROWS methods.
- Gate: lv package green.

### Commit granularity
Not a step; must be ignored.
`;
  const { steps, ambiguous, strategy } = extractPlan(doc);
  assert.equal(ambiguous, false);
  assert.equal(strategy, "heading");
  assert.deepEqual(steps.map((s) => s.id), ["S1", "S2"]);
  assert.match(steps[0]!.text, /Step 0 \u2014 baseline/);
  assert.match(steps[0]!.text, /Read the templates/);
  assert.match(steps[1]!.text, /add ROWS codec/);
  // The trailing non-step heading is not captured as a step.
  assert.ok(!steps.some((s) => /Commit granularity/.test(s.text)));
});

test("plan: normalized manifest lists each step under its stable id", () => {
  const doc = "## Implementation plan\n\n### Step 1 — do a thing\n- detail\n";
  const { normalizedMarkdown } = extractPlan(doc);
  assert.match(normalizedMarkdown, /# QFB Prepared Plan/);
  assert.match(normalizedMarkdown, /## S1/);
  assert.match(normalizedMarkdown, /do a thing/);
});

test("report: parses structured block and selects findings by policy", () => {
  const raw = "intro\n```qfb-review\n" +
    JSON.stringify({ verdict: "blocking", testGatePassed: true, findings: [
      { id: "F1", severity: "critical", location: "A.java:1", evidence: "npe" },
      { id: "F2", severity: "moderate", location: "B.java:2", evidence: "x" },
      { id: "F3", severity: "adjacent", location: "C.java", evidence: "y" },
    ] }) + "\n```\n";
  const rep = parseReviewReport(raw);
  assert.equal(rep.verdict, "blocking");
  assert.equal(selectActionableFindings(rep, false).map((f) => f.id).join(","), "F1");
  assert.equal(selectActionableFindings(rep, true).map((f) => f.id).join(","), "F1,F2");
  assert.equal(isAcceptable(rep, false), false);
});

test("report: approved + passing gate + no critical is acceptable", () => {
  const raw = "```qfb-review\n" + JSON.stringify({ verdict: "approved", testGatePassed: true, findings: [] }) + "\n```";
  assert.equal(isAcceptable(parseReviewReport(raw), false), true);
});

test("report: ambiguous surface pauses (throws)", () => {
  assert.throws(() => parseReviewReport("just prose, no block"), AmbiguousReportError);
  assert.throws(() => parseReviewReport("```qfb-review\nnot json\n```"), AmbiguousReportError);
});

test("identity: no-progress when same finding survives limit attempts", () => {
  const id = findingIdentity({ id: "F1", location: "A:1", evidence: "same" });
  assert.deepEqual(detectNoProgress([], [id], 2), []);
  assert.deepEqual(detectNoProgress([[id]], [id], 2), [id]);
  assert.deepEqual(detectNoProgress([[id]], ["other"], 2), []);
});

test("confidentiality: matches token variants case-insensitively", () => {
  assert.ok(scanForDenyTerms("the AcmeCorp table", ["Acme Corp"]).length > 0);
  assert.ok(scanForDenyTerms("select from customer_orders", ["customer orders"]).length > 0);
  assert.equal(scanForDenyTerms("nothing sensitive", ["Acme Corp"]).length, 0);
});

test("git: dirty fingerprint reflects untracked file CONTENT, not just names", () => {
  const dir = mkdtempSync(join(tmpdir(), "qfb-git-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  const base = g(["rev-parse", "HEAD"]).trim();
  const git = new Git(dir);

  // New untracked file -> fingerprint changes.
  writeFileSync(join(dir, "new.txt"), "v1\n");
  const fp1 = git.snapshot(base).dirtyFingerprint;
  // Same filename set, different CONTENT -> fingerprint must still change.
  writeFileSync(join(dir, "new.txt"), "v2-different\n");
  const fp2 = git.snapshot(base).dirtyFingerprint;
  assert.notEqual(fp1, fp2);
});

test("stateMachine: rejects invalid transitions, allows orthogonal entry and explicit recovery", () => {
  assert.equal(canTransition(State.CREATED, State.COMPLETED), false);
  assert.equal(canTransition(State.IMPLEMENTING, State.PAUSED), true);
  assert.equal(canTransition(State.COMPLETED, State.PAUSED), false);
  assert.throws(() => assertTransition(State.READY, State.COMPLETED));
  // FAILED is recoverable by an explicit operator retry, back to the interrupted phase.
  assert.equal(canTransition(State.FAILED, State.HARDENING_FIX_BUGS), true);
  assert.equal(canTransition(State.PAUSED, State.REVIEWING), true);
  assert.equal(canTransition(State.PAUSED, State.PAUSED), false);
  // Hardening stages retry by looping on themselves; others do not.
  assert.equal(canTransition(State.HARDENING_FIX_BUGS, State.HARDENING_FIX_BUGS), true);
  assert.equal(canTransition(State.REVIEWING, State.REVIEWING), false);
  assert.equal(resumeTarget(State.VERIFYING_STEP), State.IMPLEMENTING);
  assert.equal(resumeTarget(State.FIXING), State.REVIEWING);
  assert.equal(resumeTarget(State.HARDENING_WRITE_TESTS), State.HARDENING_WRITE_TESTS);
});

const ok = (command = "mvn test", code = 0): VerifiedTest => ({ command, claimedExitCode: code, exitCode: code, logPath: "/l" });
const gate = (over: Partial<GateInput> = {}) =>
  mechanicalGate({
    mode: "writer", artifact: art(), sessionCompleted: true, before: snap(), after: snap(),
    expectedBranch: "feature/x", allowedPathPrefixes: [], denyList: [],
    changedFiles: ["src/Foo.java"], diffText: "", verifiedTests: [ok()], ...over,
  });

test("gating: passes clean DONE step", () => {
  assert.equal(gate().passed, true);
});

test("gating: fails on missing artifact, failed test, and dirty scope", () => {
  assert.equal(gate({ artifact: null, verifiedTests: [] }).passed, false);
  assert.equal(gate({ artifact: art({ testCommands: [{ command: "mvn test", exitCode: 1 }] }), verifiedTests: [ok("mvn test", 1)] }).passed, false);

  // Scope is enforced from the GIT-DERIVED changeset, not the agent's report:
  // the forbidden handoff file is present in git even though the artifact omits it.
  const scope = gate({ changedFiles: ["src/Foo.java", "handoff.md"] });
  assert.equal(scope.passed, false);
  assert.equal(scope.pause, true);
});

test("gating: the controller's real exit code wins over the claim", () => {
  const lie = gate({ verifiedTests: [{ command: "mvn test", claimedExitCode: 0, exitCode: 1, logPath: "/l" }] });
  assert.equal(lie.passed, false);
  assert.match(lie.failures.join(), /claims "mvn test" exited 0, but the controller's re-run exited 1/);
  // Every claimed command must have been re-run.
  assert.equal(gate({ verifiedTests: [] }).passed, false);
});

test("gating: failing tests are accepted only when the bugs they expose are recorded", () => {
  const exposing = art({ testCommands: [{ command: "mvn test", exitCode: 1 }], bugs: [{ id: "B1", location: "", repro: "", failingTest: "T", observed: "", expected: "" }] });
  assert.equal(gate({ artifact: exposing, verifiedTests: [ok("mvn test", 1)], allowFailingTestsWithBugs: true }).passed, true);
  const unexplained = art({ testCommands: [{ command: "mvn test", exitCode: 1 }] });
  assert.equal(gate({ artifact: unexplained, verifiedTests: [ok("mvn test", 1)], allowFailingTestsWithBugs: true }).passed, false);
});

test("gating: HEAD movement and branch changes pause", () => {
  const moved = gate({ after: snap({ head: "h2" }) });
  assert.equal(moved.passed, false);
  assert.equal(moved.pause, true);
  assert.equal(gate({ after: snap({ branch: "other" }) }).pause, true);
});

test("gating: read-only sessions must leave the checkout unchanged", () => {
  assert.equal(gate({ mode: "read-only", verifiedTests: [] }).passed, true);
  const touched = gate({ mode: "read-only", after: snap({ dirtyFingerprint: "other" }), verifiedTests: [] });
  assert.equal(touched.passed, false);
  assert.equal(touched.pause, true);
});

test("gating: confidentiality leak in working-tree diff content pauses the gate", () => {
  // The deny-listed term appears only in the diff CONTENT (not a file name and
  // not in the agent's self-reported changedFiles) \u2014 it must still be caught.
  const r = gate({ denyList: ["AcmeCorp"], diffText: "+ // for AcmeCorp rollout" });
  assert.equal(r.passed, false);
  assert.equal(r.pause, true);
});

test("gating: submodule drift fails", () => {
  assert.equal(gate({ before: snap({ submoduleHead: "sub0" }), after: snap({ submoduleHead: "sub1" }) }).passed, false);
});

test("validateArtifact: rejects malformed artifacts instead of crashing the gate", () => {
  assert.equal(validateArtifact(null), null);
  assert.equal(validateArtifact({ status: "done" }), null);
  assert.equal(validateArtifact({ status: "DONE", testCommands: "x" }), null);
  assert.equal(validateArtifact({ status: "DONE", testCommands: [{ command: "mvn" }] }), null);
  const a = validateArtifact({ status: "DONE", summary: "s" });
  assert.deepEqual(a?.testCommands, []);
});

const THREE = `# Feature

## Implementation Plan

1. Add the column reader.
2. Wire up the WAL path.
3. Add integration tests.
`;
