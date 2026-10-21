import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { makeHarness, artifact, draftDesign, THREE_STEP_DESIGN } from "./helpers.ts";
import type { Harness, PiHandler } from "./helpers.ts";
import { drive } from "../src/drive.ts";
import type { ContinueOptions, IO } from "../src/drive.ts";
import { explain } from "../src/explain.ts";
import type { RunFacts } from "../src/explain.ts";
import type { DecisionRequest } from "../src/types.ts";

// ------------------------------------------------------------------ scripted agents

function implDone(stepId: string): PiHandler {
  return (_req, git) => {
    git.state.fingerprint = `fp-${stepId}-${Math.random().toString(16).slice(2, 6)}`;
    return { artifact: artifact({ stepId, changedFiles: [`src/${stepId}.java`] }) };
  };
}

function needsDecision(stepId: string, d: Partial<DecisionRequest>): PiHandler {
  const decision: DecisionRequest = { question: "Which way?", options: [], recommended: null, context: "", ...d };
  return () => ({ artifact: artifact({ stepId, status: "NEEDS_DECISION", summary: "needs a call", testCommands: [], decision }) });
}

const identify: PiHandler = () => ({ artifact: artifact({ kind: "coverage-gap", testCommands: [] }) });
const writeTests: PiHandler = (_req, git) => {
  git.state.fingerprint = `fp-h-${Math.random().toString(16).slice(2, 6)}`;
  return { artifact: artifact({ kind: "bug", bugs: [] }) };
};
const approved: PiHandler = (req) => {
  const p = join(req.artifactPath + ".report.md");
  writeFileSync(p, 'R\n```qfb-review\n{"verdict":"approved","testGatePassed":true,"findings":[]}\n```\n');
  return { artifact: artifact({ kind: "review", testCommands: [], reviewReportPath: p }) };
};
/** Hardening and an approving review: the rest of a run once the steps are done. */
const TAIL = [identify, writeTests, approved];

function start(h: Harness, repoPath = "/repo"): string {
  const { runId } = h.controller.init({ repoPath, designPath: h.designPath, base: "b" });
  h.controller.approve(runId);
  return runId;
}

function facts(h: Harness, runId: string): RunFacts {
  const st = h.controller.status(runId);
  return { runId, state: String(st.state), repoPath: String(st.repoPath), designPath: String(st.designPath), stopReason: null };
}

// ------------------------------------------------------------------ scripted operator

function scripted(answers: string[], interactive = true) {
  const lines: string[] = [];
  const io: IO = {
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    interactive,
    ask: async (prompt) => {
      lines.push(prompt);
      const a = answers.shift();
      if (a === undefined) throw new Error(`unexpected question: ${prompt}`);
      return a;
    },
    edit: async () => {},
  };
  return { io, text: () => lines.join("\n"), left: () => answers.length };
}

function continueRun(h: Harness, runId: string, io: IO, opts: ContinueOptions = {}) {
  const finished: string[] = [];
  const done = drive({
    ctl: h.controller,
    runId,
    io,
    opts,
    run: (id) => h.controller.run(id),
    finish: async (id) => {
      finished.push(id);
      return 0;
    },
  });
  return { done, finished };
}

// ------------------------------------------------------------------ decisions

test("an agent's question pauses the run with its options; the answer reaches every later session", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    needsDecision("S1", {
      question: "Range frames over scalar arguments: treat as constant, or reject?",
      options: ["Treat as constant", "Reject at compile time"],
      recommended: 1,
      context: "The design allows both.",
    }),
  ]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");

  const b = h.controller.blocker(runId);
  assert.equal(b?.kind, "decision");
  const why = explain(facts(h, runId), b);
  assert.equal(why.title, "Step S1 needs your decision");
  assert.ok(why.details.includes("  2) Reject at compile time   (recommended)"));
  assert.ok(why.details.includes("Why it matters: The design allows both."));
  assert.ok(why.actions.some((a) => a.includes(`qfb continue ${runId} --option N | --answer "..."`)));

  await assert.rejects(() => h.controller.decide(runId, { option: 3 }), /between 1 and 2/);
  for (const x of [implDone("S1"), implDone("S2"), implDone("S3"), ...TAIL]) h.pi.push(x);
  assert.equal(await h.controller.decide(runId, { option: 2, answer: "and document it" }), "IMPLEMENTING");
  assert.equal(h.controller.blocker(runId), null);
  assert.deepEqual(
    h.controller.decisions(runId).map((d) => [d.stepId, d.answer, d.designRevised]),
    [["S1", "Reject at compile time (and document it)", false]],
  );

  assert.equal(await h.controller.run(runId), "COMPLETED");
  const prompts = h.pi.launches.map((l) => l.prompt);
  assert.ok(!prompts[0]!.includes("Operator decisions"));
  for (const p of prompts.slice(1)) assert.match(p, /Q: Range frames over scalar arguments[\s\S]*A: Reject at compile time \(and document it\)/);
  assert.match(prompts.at(-1)!, /already settled for this feature \(do not raise findings that contradict them\)/);
  // Agents are told to ask rather than guess, and where their notes go.
  assert.match(prompts[0]!, /set status NEEDS_DECISION and fill decision/);
  assert.match(prompts[0]!, new RegExp(`Keep notes, analyses and drafts in ${join(h.dir, "artifacts", runId, "scratch")}`));
});

test("an agent drafts the design change for an answer; only the reviewed draft is applied, and the revised plan runs", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [implDone("S1"), needsDecision("S2", { question: "WAL or snapshot?" })]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");

  const revise = (d: string) =>
    d.replace("2. Wire up the WAL path.", "2. Wire up the snapshot path.")
      .replace("3. Add integration tests.", "3. Add integration tests.\n4. Document the snapshot path.");
  h.pi.push(draftDesign(h.designPath, revise, "S2 now uses snapshots; added a docs step"));
  const question = h.controller.question(runId);
  const draft = await h.controller.draftDesignRevision(runId, { question, answer: "Use snapshots" });
  assert.equal(draft.problem, null);
  assert.equal(draft.summary, "S2 now uses snapshots; added a docs step");
  assert.match(h.pi.launches.at(-1)!.prompt, /The operator's decision:\nUse snapshots/);
  assert.equal(readFileSync(h.designPath, "utf8"), THREE_STEP_DESIGN, "nothing changes before approval");
  assert.equal(h.controller.status(runId).state, "paused");

  const pv = h.controller.previewDesign(runId, draft.draftPath);
  assert.match(pv.designDiff!, /-2\. Wire up the WAL path\.\n\+2\. Wire up the snapshot path\./);
  assert.deepEqual(pv.planDiff, [
    "  S1  Add the column reader.",
    "+ S4  Wire up the snapshot path.",
    "  S3  Add integration tests.",
    "+ S5  Document the snapshot path.",
    "- S2  Wire up the WAL path.",
  ]);

  // Exactly what was reviewed, or nothing.
  writeFileSync(draft.draftPath, revise(THREE_STEP_DESIGN) + "\nsneaked in after review\n");
  await assert.rejects(() => h.controller.adoptDesign(runId, { hash: pv.hash, draftPath: draft.draftPath }), /changed after it was reviewed/);
  writeFileSync(draft.draftPath, revise(THREE_STEP_DESIGN));

  for (const x of [implDone("S4"), implDone("S3"), implDone("S5"), ...TAIL]) h.pi.push(x);
  const to = await h.controller.adoptDesign(runId, {
    hash: pv.hash,
    draftPath: draft.draftPath,
    decision: { question, answer: "Use snapshots" },
  });
  assert.equal(to, "IMPLEMENTING");
  assert.equal(readFileSync(h.designPath, "utf8"), revise(THREE_STEP_DESIGN));
  assert.equal(h.controller.designState(runId), "ok");
  assert.deepEqual(h.controller.decisions(runId).map((d) => [d.stepId, d.answer, d.designRevised]), [["S2", "Use snapshots", true]]);

  assert.equal(await h.controller.run(runId), "COMPLETED");
  const steps = h.controller.status(runId).steps as { id: string; status: string }[];
  assert.deepEqual(steps.map((s) => [s.id, s.status]), [["S1", "done"], ["S4", "done"], ["S3", "done"], ["S5", "done"]]);
  assert.equal(h.pi.launches.filter((l) => /-S1-/.test(l.sessionId)).length, 1, "finished work is kept");
});

test("a drafted revision that touches the checkout or edits the design in place is refused, and never moves the run", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [needsDecision("S1", {})]);
  const runId = start(h);
  await h.controller.run(runId);

  h.pi.push((req, git) => {
    git.state.fingerprint = "agent-touched-the-tree";
    writeFileSync(`${req.artifactPath}.design.md`, "draft");
    return { artifact: artifact({ kind: "design", testCommands: [], changedFiles: [] }) };
  });
  let r = await h.controller.draftDesignRevision(runId, { question: "q", answer: "a" });
  assert.match(r.problem!, /Read-only session modified the checkout/);

  h.git.state.fingerprint = "fp0";
  h.pi.push(() => {
    writeFileSync(h.designPath, "rewritten in place");
    return { artifact: artifact({ kind: "design", testCommands: [], changedFiles: [] }) };
  });
  r = await h.controller.draftDesignRevision(runId, { question: "q", answer: "a" });
  assert.match(r.problem!, /edited .*design\.md in place/);
  assert.match(r.problem!, /No draft was written/);
  assert.equal(h.controller.status(runId).state, "paused");
  assert.equal(h.controller.blocker(runId)?.kind, "decision");
});

// ------------------------------------------------------------------ gates and local docs

/** S1 leaves a note in the checkout and claims DONE without running anything. */
const noteInCheckout: PiHandler = (_req, git) => {
  git.state.fingerprint = "fp-note";
  git.state.changedFiles = ["src/A.java", "DECISION-S1-notes.md"];
  return { artifact: artifact({ stepId: "S1", testCommands: [] }) };
};

test("a gate stop lists each problem with its fix; recheck tracks what is still unresolved", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [noteInCheckout]);
  const runId = start(h);
  assert.equal(await h.controller.run(runId), "paused");
  const b = h.controller.blocker(runId);
  assert.equal(b?.kind, "gate");
  if (b?.kind !== "gate") return;
  assert.deepEqual(b.problems.map((p) => [p.code, p.human]), [["no-tests", false], ["orchestration-doc", true]]);

  const why = explain(facts(h, runId), b);
  assert.equal(why.title, "Step S1 was rejected by QFB's checks");
  assert.deepEqual(why.details, [
    "✗ Forbidden orchestration artifact in changeset: DECISION-S1-notes.md.",
    "· Claimed DONE but no validation commands ran.  (the next attempt is told; nothing for you to do)",
  ]);
  assert.deepEqual(why.actions, [
    "If an agent wrote DECISION-S1-notes.md, delete it: rm /repo/DECISION-S1-notes.md",
    `If DECISION-S1-notes.md is your own document, keep it out of commits: qfb continue ${runId} --keep-local DECISION-S1-notes.md`,
    `Then: qfb continue ${runId}  (checks your fix first)`,
  ]);

  assert.deepEqual(h.controller.recheck(runId), ["DECISION-S1-notes.md is still in the change set."]);
  assert.throws(() => h.controller.keepLocal(runId, ["src/A.java"]), /not a document/);
  assert.throws(() => h.controller.keepLocal(runId, ["../elsewhere.md"]), /not inside the checkout/);
  assert.deepEqual(h.controller.keepLocal(runId, ["DECISION-S1-notes.md"]), ["DECISION-S1-notes.md"]);
  assert.deepEqual(h.controller.recheck(runId), []);
});

test("a design inside the checkout is kept out of the feature; a missing design pauses until it is found", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, []);
  // The harness dir is the checkout and the design lives in it; paths may be given relative.
  const { runId } = h.controller.init({ repoPath: relative(process.cwd(), h.dir), designPath: relative(process.cwd(), h.designPath), base: "b" });
  assert.equal(h.controller.status(runId).designPath, h.designPath, "paths are stored absolute");
  assert.deepEqual(h.controller.localDocs(runId), ["design.md"]);
  assert.deepEqual(h.git.exclude, ["design.md"]);
  h.controller.approve(runId);

  // Moved mid-run: the run never proceeds without its design.
  const moved = join(h.dir, "notes", "..", "moved.md");
  renameSync(h.designPath, moved);
  assert.equal(await h.controller.run(runId), "paused");
  assert.deepEqual(h.controller.blocker(runId), { kind: "design-missing", path: h.designPath });
  assert.equal(h.pi.launches.length, 0);
  await assert.rejects(() => h.controller.resume(runId), /design document .*design\.md is missing/);
  assert.match(explain(facts(h, runId), h.controller.blocker(runId)).actions.join("\n"), /--design NEW_PATH/);

  h.controller.relinkDesign(runId, moved);
  assert.equal(h.controller.designState(runId), "ok", "same content: no re-approval");
  assert.deepEqual(h.controller.localDocs(runId), ["moved.md"]);
  for (const x of [implDone("S1"), implDone("S2"), implDone("S3"), ...TAIL]) h.pi.push(x);
  await h.controller.resume(runId);
  assert.equal(await h.controller.run(runId), "COMPLETED");
});

// ------------------------------------------------------------------ qfb continue

test("continue without a terminal: answers come only from options, and the next stop ends it with what to do", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [needsDecision("S1", { options: ["A", "B"], recommended: 0 })]);
  const runId = start(h);
  await h.controller.run(runId);

  let op = scripted([], false);
  let c = continueRun(h, runId, op.io);
  assert.equal(await c.done, 2);
  assert.match(op.text(), /⏸ Step S1 needs your decision/);
  assert.match(op.text(), /--option N \| --answer/);
  assert.equal(h.controller.status(runId).state, "paused");

  // It never guesses: with an answer it carries on, and stops at the next question.
  h.pi.push(implDone("S1"));
  h.pi.push(needsDecision("S2", { question: "And this?" }));
  op = scripted([], false);
  c = continueRun(h, runId, op.io, { option: 1 });
  assert.equal(await c.done, 2);
  assert.deepEqual(h.controller.decisions(runId).map((d) => d.answer), ["A"]);
  assert.match(op.text(), /⏸ Step S2 needs your decision\n  And this\?/);

  for (const x of [implDone("S2"), implDone("S3"), ...TAIL]) h.pi.push(x);
  c = continueRun(h, runId, scripted([], false).io, { answer: "Yes" });
  assert.equal(await c.done, 0);
  assert.deepEqual(c.finished, [runId]);
});

test("continue in a terminal: pick an answer, let an agent revise the design, approve the diff, run to completion", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [
    implDone("S1"),
    needsDecision("S2", { question: "WAL or snapshot?", options: ["WAL", "Snapshot"], recommended: 1 }),
  ]);
  const runId = start(h);
  await h.controller.run(runId);
  const revise = (d: string) => d.replace("Wire up the WAL path.", "Wire up the snapshot path.");
  for (const x of [draftDesign(h.designPath, revise), implDone("S4"), implDone("S3"), ...TAIL]) h.pi.push(x);

  const op = scripted(["2", "y", "a"]);
  const c = continueRun(h, runId, op.io);
  assert.equal(await c.done, 0);
  assert.equal(op.left(), 0);
  assert.match(op.text(), /\+2\. Wire up the snapshot path\./);
  assert.match(op.text(), /\+ S4 {2}Wire up the snapshot path\./);
  assert.equal(readFileSync(h.designPath, "utf8"), revise(THREE_STEP_DESIGN));
  assert.deepEqual(h.controller.decisions(runId).map((d) => [d.answer, d.designRevised]), [["Snapshot", true]]);
  assert.deepEqual(c.finished, [runId]);
});

test("continue: a design you edited yourself is shown as a diff, approved in place, and recorded as the answer", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [needsDecision("S1", { question: "Nullable?" })]);
  const runId = start(h);
  await h.controller.run(runId);
  writeFileSync(h.designPath, THREE_STEP_DESIGN.replace("Add the column reader.", "Add the column reader (nullable)."));
  for (const x of [implDone("S4"), implDone("S2"), implDone("S3"), ...TAIL]) h.pi.push(x);

  const op = scripted(["y"]);
  assert.equal(await continueRun(h, runId, op.io).done, 0);
  assert.match(op.text(), /The design changed since it was approved/);
  assert.match(op.text(), /-1\. Add the column reader\.\n\+1\. Add the column reader \(nullable\)\./);
  assert.deepEqual(
    h.controller.decisions(runId).map((d) => [d.question, d.answer, d.designRevised]),
    [["Nullable?", "Resolved by the operator's edit of the design document.", true]],
  );
});

test("continue: a gate stop is re-checked before resuming; your own doc can be kept out of the feature", async () => {
  const h = makeHarness(THREE_STEP_DESIGN, [noteInCheckout]);
  const runId = start(h);
  await h.controller.run(runId);

  // Without a terminal: an unresolved problem is reported, never resumed past.
  let op = scripted([], false);
  assert.equal(await continueRun(h, runId, op.io).done, 2);
  assert.match(op.text(), /Still unresolved:\n  ✗ DECISION-S1-notes\.md is still in the change set\./);
  assert.match(op.text(), new RegExp(`or resume regardless: qfb resume ${runId}`));
  assert.equal(h.controller.status(runId).state, "paused");

  for (const x of [implDone("S1"), implDone("S2"), implDone("S3"), ...TAIL]) h.pi.push(x);
  op = scripted(["k"]);
  assert.equal(await continueRun(h, runId, op.io).done, 0);
  assert.match(op.text(), /\[k\] keep DECISION-S1-notes\.md out of the feature/);
  assert.deepEqual(h.controller.localDocs(runId), ["DECISION-S1-notes.md"]);
  assert.equal(h.controller.status(runId).state, "COMPLETED");
});

test("continue: a run that gave up is retried with the operator's guidance", async () => {
  const fail: PiHandler = () => ({ artifact: artifact({ stepId: "S1", status: "FAILED", testCommands: [] }) });
  const h = makeHarness(THREE_STEP_DESIGN, [fail]);
  const { runId } = h.controller.init({ repoPath: "/repo", designPath: h.designPath, base: "b", config: { maxImplAttemptsPerStep: 1 } });
  h.controller.approve(runId);
  assert.equal(await h.controller.run(runId), "failed");
  assert.equal(explain(facts(h, runId), h.controller.blocker(runId)).title, "The run gave up");

  for (const x of [implDone("S1"), implDone("S2"), implDone("S3"), ...TAIL]) h.pi.push(x);
  const op = scripted(["Use the existing reader as a template", "n"]);
  assert.equal(await continueRun(h, runId, op.io).done, 0);
  assert.match(op.text(), /\[c\] retry as is · \[t\] retry with guidance/);
  assert.match(h.pi.launches[1]!.prompt, /A: Use the existing reader as a template/);
});

test("explain: concrete, copy-pasteable fixes", () => {
  const f: RunFacts = { runId: "run-1", state: "paused", repoPath: "/w/my repo", designPath: "/w/d.md", stopReason: null };
  const why = explain(f, {
    kind: "gate",
    stage: "IMPLEMENTING",
    stepId: "S2",
    problems: [
      { code: "head-moved", message: "HEAD moved", human: true, expected: "aaa", actual: "bbb" },
      { code: "branch-changed", message: "branch", human: true, expected: "feature/x", actual: "main" },
      { code: "deny-term", message: "leak", human: true, files: ["src/A.java"], term: "AcmeCorp" },
    ],
  });
  assert.deepEqual(why.actions, [
    "An agent committed. Undo the commit, keeping its changes: git -C '/w/my repo' reset --soft aaa",
    "Switch back: git -C '/w/my repo' switch feature/x",
    'Remove "AcmeCorp" from src/A.java (matched regardless of case and separators)',
    "Then: qfb continue run-1  (checks your fix first)",
  ]);
  // A stop recorded before blockers existed still points somewhere.
  assert.deepEqual(explain({ ...f, stopReason: "old reason" }, null), {
    title: "old reason",
    details: [],
    actions: ["Continue: qfb continue run-1"],
  });
});
