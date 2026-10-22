import { test } from "node:test";
import assert from "node:assert/strict";
import { progressLines, phaseGroup, SPINNER, titleText, titleSequence } from "../src/progress.ts";
import type { StepView } from "../src/progress.ts";

const steps: StepView[] = [
  { id: "S1", status: "done", attempts: 1, text: "Step 0 — baseline" },
  { id: "S2", status: "active", attempts: 2, text: "Step 1 — ROWS codec" },
  { id: "S3", status: "pending", attempts: 0, text: "Step 2 — RANGE codec" },
];

test("phaseGroup maps controller states to high-level phases", () => {
  assert.equal(phaseGroup("IMPLEMENTING"), "implementation");
  assert.equal(phaseGroup("CHECKPOINTING"), "implementation");
  assert.equal(phaseGroup("HARDENING_WRITE_TESTS"), "hardening");
  assert.equal(phaseGroup("REVIEWING"), "review/fix");
  assert.equal(phaseGroup("FIXING"), "review/fix");
  assert.equal(phaseGroup("COMPLETED"), "completed");
});

test("progressLines marks done/active/pending and spins the active step", () => {
  const lines = progressLines({
    state: "IMPLEMENTING",
    sessionCount: 2,
    steps,
    currentSession: null,
    columns: 200,
    frame: 0,
  });
  // header + 3 steps (no session line during implementation)
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /\u25b8 implementation/); // current phase marked
  assert.match(lines[1]!, /\u2713 S1/); // done
  assert.ok(lines[2]!.includes(SPINNER[0]!) && lines[2]!.includes("S2")); // active spinner
  assert.match(lines[2]!, /\(attempt 2\)/);
  assert.match(lines[3]!, /\u25cb S3/); // pending
});

test("progressLines truncates long lines to the terminal width", () => {
  const lines = progressLines({
    state: "IMPLEMENTING",
    sessionCount: 0,
    steps: [{ id: "S1", status: "active", attempts: 1, text: "x".repeat(500) }],
    currentSession: null,
    columns: 40,
    frame: 3,
  });
  assert.ok(lines[1]!.length <= 40);
  assert.ok(lines[1]!.endsWith("\u2026"));
});

test("progressLines shows the agent session line outside implementation", () => {
  const lines = progressLines({
    state: "REVIEWING",
    sessionCount: 7,
    steps,
    currentSession: { kind: "review", stepId: "review", status: "DONE", endedAt: null },
    columns: 200,
    frame: 1,
  });
  const last = lines[lines.length - 1]!;
  assert.match(last, /review: step=review/);
  assert.match(last, /running/);
});

test("titleText shows the work while running, and a stop or completion at a glance", () => {
  const t = { runId: "run-1234abcd", stepsDone: 2, stepsTotal: 7, frame: 1 };
  assert.equal(titleText({ ...t, state: "IMPLEMENTING" }), `${SPINNER[1]} qfb run-1234abcd \u00b7 implementation 2/7`);
  assert.match(titleText({ ...t, state: "HARDENING_FIX_BUGS" }), /hardening 2\/7$/);
  assert.notEqual(titleText({ ...t, state: "REVIEWING" }), titleText({ ...t, state: "REVIEWING", frame: 2 })); // spins
  assert.equal(titleText({ ...t, state: "blocked" }), "\u23f8 qfb run-1234abcd \u00b7 needs you (blocked)");
  assert.equal(titleText({ ...t, state: "COMPLETED" }), "\u2713 qfb run-1234abcd \u00b7 complete");
});

test("titleSequence sets the title with OSC 0 and cannot be escaped by its text", () => {
  assert.equal(titleSequence("qfb"), "\x1b]0;qfb\x07");
  assert.equal(titleSequence("a\x07b\x1b]0;evil\x9cc\n"), "\x1b]0;ab]0;evilc\x07");
});
