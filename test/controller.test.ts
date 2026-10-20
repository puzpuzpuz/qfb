import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeHarness, artifact, THREE_STEP_DESIGN } from "./helpers.ts";
import type { PiHandler } from "./helpers.ts";
import type { PiLaunchRequest } from "../src/adapters/pi.ts";

/** Impl handler: mutates git to simulate a code change and claims DONE. */
function implDone(stepId: string): PiHandler {
  return (_req, git) => {
    git.state.fingerprint = "fp-" + stepId + "-" + Math.random().toString(16).slice(2, 6);
    return { artifact: artifact({ stepId, kind: "implementation", status: "DONE", changedFiles: ["src/" + stepId + ".java"] }) };
  };
}

function hardening(kind: "coverage-gap" | "bug", bugs: unknown[] = []): PiHandler {
  return () => ({ artifact: artifact({ kind: kind as never, status: "DONE", testCommands: [], bugs: bugs as never }) });
}

function writeReport(req: PiLaunchRequest, report: unknown): string {
  const p = join(dirname(req.artifactPath), req.sessionId + "-raw.md");
  writeFileSync(p, "Review report\n```qfb-review\n" + JSON.stringify(report) + "\n```\n");
  return p;
}

function review(report: unknown, mutateGit = false): PiHandler {
  return (req, git) => {
    const reportPath = writeReport(req, report);
    if (mutateGit) git.state.fingerprint = "changed-during-review";
    return { artifact: artifact({ kind: "review", status: "DONE", testCommands: [], reviewReportPath: reportPath }) };
  };
}

function fix(outcome: string): PiHandler {
  return () => ({ artifact: artifact({ kind: "fix", status: "DONE", testCommands: [], fixOutcome: outcome as never }) });
}

const HAPPY_HARDENING = [hardening("coverage-gap"), hardening("bug", []), hardening("bug", [])];
const APPROVED = { verdict: "approved", testGatePassed: true, findings: [] };

test("three-step plan completes using three separate fresh Pi sessions", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"),
    ...HAPPY_HARDENING,
    review(APPROVED),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "base~0" });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);

  assert.equal(state, "COMPLETED");
  const implLaunches = h.pi.launches.filter((l) => /^run-.*-S\d-/.test(l.sessionId));
  assert.equal(implLaunches.length, 3);
  // Fresh session per step: all session ids distinct.
  assert.equal(new Set(implLaunches.map((l) => l.sessionId)).size, 3);
  // Serial order preserved.
  assert.deepEqual(implLaunches.map((l) => l.stepId), ["S1", "S2", "S3"]);
  const st = h.controller.status(runId);
  assert.equal(st.stepsDone, 3);
});

test("the next step cannot begin before the previous one passes verification", async () => {
  // S1 fails its test gate once, then succeeds; S2 must not launch until S1 done.
  const h = makeHarness(THREE_STEP_DESIGN, [
    (_r, git) => { git.state.fingerprint = "fpS1a"; return { artifact: artifact({ stepId: "S1", testCommands: [{ command: "mvn test", exitCode: 1, logPath: "/l" }] }) }; },
    implDone("S1"),
    implDone("S2"), implDone("S3"),
    ...HAPPY_HARDENING, review(APPROVED),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b" });
  h.controller.approve(runId);
  await h.controller.run(runId);
  const order = h.pi.launches.filter((l) => /-S\d-/.test(l.sessionId)).map((l) => l.stepId);
  // S1 appears twice (retry) before S2 ever starts.
  assert.deepEqual(order.slice(0, 3), ["S1", "S1", "S2"]);
});

test("a failed test prevents step completion and exhausts attempts -> FAILED", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    (_r, git) => { git.state.fingerprint = "x"; return { artifact: artifact({ stepId: "S1", testCommands: [{ command: "mvn test", exitCode: 1, logPath: "/l" }] }) }; },
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b", config: { maxImplAttemptsPerStep: 1 } });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);
  assert.equal(state, "failed");
  const st = h.controller.status(runId);
  assert.notEqual(st.steps instanceof Array && (st.steps as { id: string; status: string }[])[0]!.status, "done");
});

test("mechanical gating rejects a DONE claim with no artifact", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    () => ({ artifact: null, settled: true }),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b", config: { maxImplAttemptsPerStep: 1 } });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);
  assert.equal(state, "failed");
});

test("NEEDS_DECISION pauses the run for a human decision", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    () => ({ artifact: artifact({ stepId: "S1", status: "NEEDS_DECISION", summary: "architectural fork" }) }),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b" });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);
  assert.equal(state, "paused");
  assert.match(String(h.controller.status(runId).stopReason), /human decision/);
});

test("edited design document invalidates approval until reconciled", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1")]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b" });
  h.controller.approve(runId);
  writeFileSync(h.designPath, THREE_STEP_DESIGN + "\n4. Sneaky extra step.\n");
  const state = await h.controller.run(runId);
  assert.equal(state, "paused");
  assert.match(String(h.controller.status(runId).stopReason), /re-approval/);
  // Re-approve and the run can proceed again.
  h.controller.approve(runId);
  assert.equal(h.controller.status(runId).state, "READY");
});

test("blocking review triggers fix-pr then a fresh review that completes", async () => {
  const blocking = { verdict: "blocking", testGatePassed: true, findings: [{ id: "F1", severity: "critical", location: "A:1", evidence: "npe-v1" }] };
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review(blocking), fix("Clean"), review(APPROVED),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b" });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);
  assert.equal(state, "COMPLETED");
  assert.equal(h.controller.status(runId).reviews, 2);
  assert.ok(h.pi.launches.some((l) => l.sessionId.includes("-fix-")));
});

test("needs-discussion verdict pauses the run", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review({ verdict: "needs-discussion", testGatePassed: true, findings: [] }),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b" });
  h.controller.approve(runId);
  assert.equal(await h.controller.run(runId), "paused");
});

test("fix-pr Blocked stops normal progression", async () => {
  const blocking = { verdict: "blocking", testGatePassed: true, findings: [{ id: "F1", severity: "critical", location: "A:1", evidence: "x" }] };
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review(blocking), fix("Blocked"),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b" });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);
  assert.equal(state, "failed");
  assert.match(String(h.controller.status(runId).stopReason), /Blocked/);
});

test("stale review result is rejected after the checkout changes", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review(APPROVED, /* mutateGit */ true),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b" });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);
  assert.equal(state, "paused");
  assert.match(String(h.controller.status(runId).stopReason), /stale/i);
});

test("review/fix loop respects configured iteration limit", async () => {
  // Always blocking with CHANGING finding identity so no-progress never trips.
  const h = makeHarness(THREE_STEP_DESIGN, []);
  let n = 0;
  const blockingN = (): PiHandler => (req, git) => {
    const reportPath = writeReportLocal(req, { verdict: "blocking", testGatePassed: true, findings: [{ id: "F" + n, severity: "critical", location: "A:" + n, evidence: "e" + n++ }] });
    void git;
    return { artifact: artifact({ kind: "review", status: "DONE", testCommands: [], reviewReportPath: reportPath }) };
  };
  h.pi.push(implDone("S1")); h.pi.push(implDone("S2")); h.pi.push(implDone("S3"));
  for (const x of HAPPY_HARDENING) h.pi.push(x);
  for (let i = 0; i < 10; i++) { h.pi.push(blockingN()); h.pi.push(fix("Clean")); }
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b", config: { maxReviewIterations: 2 } });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);
  assert.equal(state, "failed");
  assert.match(String(h.controller.status(runId).stopReason), /iteration limit/i);
});

test("recurring blocker with unchanged finding identity is detected as no-progress", async () => {
  const same = { verdict: "blocking", testGatePassed: true, findings: [{ id: "F1", severity: "critical", location: "A:1", evidence: "same-evidence" }] };
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"), implDone("S2"), implDone("S3"), ...HAPPY_HARDENING,
    review(same), fix("Clean"), review(same), fix("Clean"), review(same),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b", config: { maxReviewIterations: 10, maxNoProgress: 2 } });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);
  assert.equal(state, "failed");
  assert.match(String(h.controller.status(runId).stopReason), /without progress/i);
});

test("hard ceiling on total Pi sessions is enforced", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1"), implDone("S2"), implDone("S3")]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b", config: { maxTotalSessions: 2 } });
  h.controller.approve(runId);
  const state = await h.controller.run(runId);
  assert.equal(state, "failed");
  assert.match(String(h.controller.status(runId).stopReason), /ceiling/i);
});

test("two controller instances cannot run concurrently against the same run", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1")]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b" });
  h.controller.approve(runId);
  assert.equal(h.store.acquireLock(runId), true); // simulate another instance holding the lock
  await assert.rejects(() => h.controller.run(runId), /locked by another controller/);
  h.store.releaseLock(runId);
});

test("build-style run is interruptible and resumes without duplicating completed work", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"),
    () => ({ artifact: artifact({ stepId: "S2", status: "NEEDS_DECISION", summary: "needs a call" }) }),
  ]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b" });
  h.controller.approve(runId);

  // First invocation stops at the decision point.
  const first = await h.controller.run(runId);
  assert.equal(first, "paused");
  assert.equal(h.controller.status(runId).stepsDone, 1);
  const s1LaunchesAfterFirst = h.pi.launches.filter((l) => /-S1-/.test(l.sessionId)).length;
  assert.equal(s1LaunchesAfterFirst, 1);

  // Operator addresses it; queue the rest of the happy path and resume.
  h.pi.push(implDone("S2")); h.pi.push(implDone("S3"));
  for (const x of HAPPY_HARDENING) h.pi.push(x);
  h.pi.push(review(APPROVED));
  h.controller.resume(runId);

  const second = await h.controller.run(runId);
  assert.equal(second, "COMPLETED");
  assert.equal(h.controller.status(runId).stepsDone, 3);
  // S1 was never re-launched during the resumed run.
  assert.equal(h.pi.launches.filter((l) => /-S1-/.test(l.sessionId)).length, 1);
});

test("findRun locates an existing run for the same repo/design/base (resumption key)", () => {
  const h = makeHarness(THREE_STEP_DESIGN, []);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "base-ref" });
  const found = h.store.findRun("/repo", h.designPath, "base-ref");
  assert.equal(found?.id, runId);
  assert.equal(h.store.findRun("/repo", h.designPath, "other-base"), null);
});

function writeReportLocal(req: PiLaunchRequest, report: unknown): string {
  const p = join(dirname(req.artifactPath), req.sessionId + "-raw.md");
  writeFileSync(p, "```qfb-review\n" + JSON.stringify(report) + "\n```\n");
  return p;
}
