import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPlan } from "../src/plan.ts";
import { parseReviewReport, selectActionableFindings, isAcceptable, AmbiguousReportError } from "../src/report.ts";
import { detectNoProgress, findingIdentity } from "../src/identity.ts";
import { scanForDenyTerms } from "../src/confidentiality.ts";
import { canTransition, assertTransition } from "../src/stateMachine.ts";
import { mechanicalGate } from "../src/gating.ts";
import { State } from "../src/types.ts";
import type { GitSnapshot, TaskArtifact } from "../src/types.ts";

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

test("stateMachine: rejects invalid transitions, allows orthogonal entry", () => {
  assert.equal(canTransition(State.CREATED, State.COMPLETED), false);
  assert.equal(canTransition(State.IMPLEMENTING, State.PAUSED), true);
  assert.equal(canTransition(State.COMPLETED, State.PAUSED), false);
  assert.throws(() => assertTransition(State.READY, State.COMPLETED));
});

test("gating: passes clean DONE step", () => {
  const r = mechanicalGate({
    artifact: art(), sessionCompleted: true, before: snap(), after: snap(),
    expectedBranch: "feature/x", allowedPathPrefixes: [], denyList: [], stagedDiff: "",
  });
  assert.equal(r.passed, true);
});

test("gating: fails on missing artifact, failed test, and dirty scope", () => {
  assert.equal(mechanicalGate({ artifact: null, sessionCompleted: true, before: snap(), after: snap(), expectedBranch: "feature/x", allowedPathPrefixes: [], denyList: [], stagedDiff: "" }).passed, false);

  const failedTest = mechanicalGate({
    artifact: art({ testCommands: [{ command: "mvn test", exitCode: 1, logPath: "/l" }] }),
    sessionCompleted: true, before: snap(), after: snap(), expectedBranch: "feature/x",
    allowedPathPrefixes: [], denyList: [], stagedDiff: "",
  });
  assert.equal(failedTest.passed, false);

  const scope = mechanicalGate({
    artifact: art({ changedFiles: ["src/Foo.java", "handoff.md"] }),
    sessionCompleted: true, before: snap(), after: snap(), expectedBranch: "feature/x",
    allowedPathPrefixes: [], denyList: [], stagedDiff: "",
  });
  assert.equal(scope.passed, false);
  assert.equal(scope.pause, true);
});

test("gating: confidentiality leak pauses the gate", () => {
  const r = mechanicalGate({
    artifact: art(), sessionCompleted: true, before: snap(), after: snap(),
    expectedBranch: "feature/x", allowedPathPrefixes: [], denyList: ["AcmeCorp"],
    stagedDiff: "+ // for AcmeCorp rollout",
  });
  assert.equal(r.passed, false);
  assert.equal(r.pause, true);
});

test("gating: submodule drift fails", () => {
  const r = mechanicalGate({
    artifact: art(), sessionCompleted: true, before: snap({ submoduleHead: "sub0" }),
    after: snap({ submoduleHead: "sub1" }), expectedBranch: "feature/x",
    allowedPathPrefixes: [], denyList: [], stagedDiff: "",
  });
  assert.equal(r.passed, false);
});

const THREE = `# Feature

## Implementation Plan

1. Add the column reader.
2. Wire up the WAL path.
3. Add integration tests.
`;
