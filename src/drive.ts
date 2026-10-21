/**
 * `qfb continue`, and the tail of `qfb build`: take a run from wherever it is
 * to completion, helping the operator through every stop on the way. Each
 * stop is explained (explain.ts) and resolved in place: approve a plan or an
 * edited design, answer an agent's question (optionally letting an agent draft
 * the matching design change, applied only after the operator approves the
 * diff), check that a gate problem was fixed, vet unscannable files, retry.
 *
 * With a terminal the loop keeps going until the run completes or the operator
 * stops. Without one nothing is asked: invoking `continue` is consent to
 * resume, answers come only from options, and the next stop ends the command.
 * I/O is injected, so every flow is testable.
 */
import { State } from "./types.ts";
import type { Blocker, StateName } from "./types.ts";
import { isOrthogonal } from "./stateMachine.ts";
import { explain, renderExplanation } from "./explain.ts";
import type { RunFacts } from "./explain.ts";
import type { Controller } from "./controller.ts";

export interface IO {
  out(s: string): void;
  err(s: string): void;
  /** A person at a terminal. Without one, nothing is asked. */
  interactive: boolean;
  ask(prompt: string): Promise<string>;
  /** Open a file in the operator's editor; resolves once it is closed. */
  edit(path: string): Promise<void>;
}

export interface ContinueOptions {
  /** Consent to a clear, first-time plan (never to an ambiguous plan or a changed design). */
  yes?: boolean;
  /** Answer the pending question with option N (1-based) ... */
  option?: number;
  /** ... and/or this text (or give guidance for a retry). */
  answer?: string;
  /** The operator checked the files the confidentiality scan could not read. */
  acceptUnscannable?: boolean;
  /** Documents in the checkout to keep out of the feature. */
  keepLocal?: string[];
  /** The design document's new location. */
  design?: string;
}

export interface Drive {
  ctl: Controller;
  runId: string;
  io: IO;
  opts: ContinueOptions;
  /** Drive the controller to its next stopping point (with a progress view). */
  run(runId: string): Promise<StateName>;
  /** After COMPLETED: report, and open the PR if this run should have one. Returns the exit code. */
  finish(runId: string): Promise<number>;
}

/** Exit codes: 0 completed (or plan not approved), 1 approval needed, 2 stopped and waiting on a person. */
export async function drive(d: Drive): Promise<number> {
  const opts: ContinueOptions = { ...d.opts };
  let ran = false;
  for (let guard = 0; guard < 1000; guard++) {
    const state = d.ctl.status(d.runId).state as StateName;
    if (state === State.COMPLETED) return d.finish(d.runId);
    if (state === State.AWAITING_APPROVAL) {
      const r = await approvePlan(d, opts);
      if (r !== null) return r;
      continue;
    }
    if (state === State.CREATED || state === State.PREPARING) {
      throw new Error(`Run ${d.runId} was interrupted while being prepared (${state}); start a new run.`);
    }
    if (isOrthogonal(state)) {
      if (ran && !d.io.interactive) {
        show(d);
        return 2;
      }
      const r = await resolveStop(d, opts);
      // Answers and other one-shot options apply to the stop they were given for.
      for (const k of ["option", "answer", "acceptUnscannable", "keepLocal", "design"] as const) delete opts[k];
      if (r === "resumed") continue;
      if (r === "stopped") d.io.out(`\nStopped here. Pick up again with: qfb continue ${d.runId}`);
      return 2;
    }
    ran = true;
    await d.run(d.runId);
  }
  throw new Error("continue: too many rounds");
}

type Outcome = "resumed" | "stopped" | "waiting";

function facts(d: Drive): RunFacts {
  const st = d.ctl.status(d.runId);
  return {
    runId: d.runId,
    state: String(st.state),
    repoPath: String(st.repoPath),
    designPath: String(st.designPath),
    stopReason: (st.stopReason as string | null) ?? null,
  };
}

function show(d: Drive, b: Blocker | null = d.ctl.blocker(d.runId)): void {
  d.io.out("");
  for (const l of renderExplanation(explain(facts(d), b))) d.io.out(l);
}

async function choose(d: Drive, prompt: string, valid: (a: string) => boolean): Promise<string> {
  for (;;) {
    const a = (await d.io.ask(prompt)).trim();
    if (valid(a)) return a;
  }
}

async function yesNo(d: Drive, prompt: string, dflt: boolean): Promise<boolean> {
  const a = (await d.io.ask(prompt)).trim().toLowerCase();
  return a === "" ? dflt : /^y(es)?$/.test(a);
}

// ------------------------------------------------------------- approval
async function approvePlan(d: Drive, opts: ContinueOptions): Promise<number | null> {
  const { ctl, io, runId } = d;
  const plan = ctl.refreshPlan(runId);
  if (plan.diff.length > 0) {
    io.out("The design changed, and with it the plan steps (+ new, - removed):");
    for (const l of plan.diff) io.out(`  ${l}`);
  }
  for (const n of plan.notes.filter((n) => n.startsWith("AMBIGUOUS"))) io.out(`  ${n}`);
  if (plan.steps === 0) {
    io.err(`No plan steps could be extracted from ${facts(d).designPath}; give it an ordered Implementation Plan, then re-run. Nothing started.`);
    return 1;
  }
  const steps = ctl.status(runId).steps as { id: string; text: string }[];
  io.out(`Plan for ${runId} (${steps.length} step(s); full manifest: ${plan.preparedPlanPath}):`);
  for (const s of steps) io.out(`  ${s.id}  ${s.text}`);
  const why = plan.ambiguous ? "the plan structure is ambiguous" : null;
  if (why || !opts.yes) {
    if (!io.interactive) {
      io.err(
        why
          ? `Explicit approval required because ${why}; --yes does not cover this. Review 'qfb plan ${runId}', ` +
              `then 'qfb approve ${runId}' and re-run (or edit the design and re-run).`
          : `Approval required. Review 'qfb plan ${runId}', then re-run with --yes (or 'qfb approve ${runId}').`,
      );
      return 1;
    }
    if (why) io.out(`! Attention: ${why}.`);
    if (!(await yesNo(d, `Approve this plan and start the autonomous build of ${runId}? [y/N] `, false))) {
      io.out(`Not approved; nothing started. Re-run to resume.`);
      return 0;
    }
  }
  ctl.approve(runId);
  io.out(`Approved ${runId}.`);
  return null;
}

// ------------------------------------------------------------- stops
async function resolveStop(d: Drive, opts: ContinueOptions): Promise<Outcome> {
  const { ctl, io, runId } = d;

  const design = ctl.designState(runId);
  if (design === "missing") {
    if (opts.design) {
      ctl.relinkDesign(runId, opts.design);
      opts.design = undefined;
      io.out(`The run now uses the design at ${facts(d).designPath}.`);
      return resolveStop(d, opts);
    }
    show(d, { kind: "design-missing", path: facts(d).designPath });
    if (!io.interactive) return "waiting";
    const p = (await io.ask("Where is the design document now? (path; empty to stop) ")).trim();
    if (!p) return "stopped";
    ctl.relinkDesign(runId, p);
    return resolveStop(d, opts);
  }
  if (design === "changed") return reviewEditedDesign(d);

  const b = ctl.blocker(runId);
  show(d, b);
  switch (b?.kind) {
    case "decision":
      return answer(d, opts, b);
    case "budget":
      return answer(d, opts, null);
    case "gate":
      return fixGate(d, opts);
    case "unscannable":
      return vet(d, opts);
    case "session-running": {
      if (!io.interactive) return "waiting";
      const a = await choose(d, "\n[k] stop that session now · [s] leave it running and stop here > ", (x) => x === "k" || x === "s");
      if (a === "s") return "stopped";
      await ctl.stop(runId);
      return resolveStop(d, opts);
    }
    case "interrupted":
    case "git-error":
    case "regression":
      // Something in the checkout needs a person first; invoking continue without a terminal is the go-ahead.
      if (io.interactive && !(await yesNo(d, "\nDone? Continue now [Y/n] ", true))) return "stopped";
      break;
    default:
      break;
  }
  await ctl.resume(runId);
  return "resumed";
}

/**
 * The design on disk differs from the approved one: show the change and what
 * it does to the plan, and approve exactly that. If the run was waiting for a
 * decision, the edit is recorded as its answer.
 */
async function reviewEditedDesign(d: Drive): Promise<Outcome> {
  const { ctl, io, runId } = d;
  const b = ctl.blocker(runId);
  io.out(`\nThe design changed since it was approved (${facts(d).designPath}).`);
  const pv = ctl.previewDesign(runId);
  showPreview(d, pv);
  if (pv.steps === 0) {
    io.err("No plan steps can be extracted from it; give it an ordered Implementation Plan, then continue.");
    return "waiting";
  }
  if (!io.interactive) {
    io.err(`An edited design needs your approval: run 'qfb continue ${runId}' in a terminal.`);
    return "waiting";
  }
  if (!(await yesNo(d, "\nApprove the edited design and continue? [y/N] ", false))) return "stopped";
  const decision =
    b?.kind === "decision" ? { question: b.question, answer: "Resolved by the operator's edit of the design document." } : undefined;
  await ctl.adoptDesign(runId, { hash: pv.hash, ...(decision ? { decision } : {}) });
  return "resumed";
}

function showPreview(d: Drive, pv: ReturnType<Controller["previewDesign"]>): void {
  const { io } = d;
  if (pv.designDiff) {
    io.out("");
    for (const l of pv.designDiff.replace(/\n$/, "").split("\n")) io.out(l);
  }
  io.out("");
  if (pv.planDiff.length > 0) {
    io.out("Plan change (+ new, - removed; finished steps keep their status):");
    for (const l of pv.planDiff) io.out(`  ${l}`);
  } else {
    io.out("The plan steps are unchanged.");
  }
  for (const n of pv.notes.filter((n) => n.startsWith("AMBIGUOUS"))) io.out(`  ${n}`);
}

/**
 * Answer the run's question (`b`), or give guidance for a retry (`b` null).
 * Optionally have an agent draft the matching design change.
 */
async function answer(d: Drive, opts: ContinueOptions, b: Extract<Blocker, { kind: "decision" }> | null): Promise<Outcome> {
  const { ctl, io, runId } = d;
  if (opts.option !== undefined || opts.answer) {
    await ctl.decide(runId, { ...(opts.option !== undefined ? { option: opts.option } : {}), ...(opts.answer ? { answer: opts.answer } : {}) });
    return "resumed";
  }
  if (!io.interactive) {
    if (b) return "waiting";
    await ctl.resume(runId); // a retry: invoking continue is the go-ahead
    return "resumed";
  }
  const n = b?.options.length ?? 0;
  const menu = b
    ? `\n${n ? `[1-${n}] pick an option · ` : ""}[t] type your answer (or just type it) · [s] stop for now > `
    : `\n[c] retry as is · [t] retry with guidance for the agent (or just type it) · [s] stop for now > `;
  const a = await choose(d, menu, (x) => x.length > 0);
  if (a === "s") return "stopped";
  if (a === "c" && !b) {
    await ctl.resume(runId);
    return "resumed";
  }
  let option: number | undefined;
  let text: string | undefined;
  if (b && n > 0 && /^\d+$/.test(a)) {
    option = Number(a);
    if (option < 1 || option > n) return answer(d, opts, b);
  } else if (a === "t") {
    text = await choose(d, "Your answer: ", (x) => x.length > 0);
  } else {
    text = a;
  }
  const given = { ...(option !== undefined ? { option } : {}), ...(text ? { answer: text } : {}) };
  const answerText = ctl.answerText(runId, given);
  if (!(await yesNo(d, "Update the design to match? An agent drafts the change for your approval. [y/N] ", false))) {
    await ctl.decide(runId, given);
    return "resumed";
  }
  return revise(d, ctl.question(runId), answerText, given);
}

/** Have an agent draft the design change for an answer; apply it only once the operator approves the diff. */
async function revise(
  d: Drive,
  question: string,
  answerText: string,
  given: { option?: number; answer?: string },
): Promise<Outcome> {
  const { ctl, io, runId } = d;
  io.out("\nAsking an agent to draft the design change\u2026");
  let draft = await ctl.draftDesignRevision(runId, { question, answer: answerText });
  for (;;) {
    if (draft.problem) {
      io.err(`\nThe draft cannot be used: ${draft.problem}`);
      const a = await choose(d, "[r] try again · [k] keep your answer, leave the design as is · [s] stop > ", (x) => ["r", "k", "s"].includes(x));
      if (a === "s") return "stopped";
      if (a === "k") {
        await ctl.decide(runId, given);
        return "resumed";
      }
      draft = await ctl.draftDesignRevision(runId, { question, answer: answerText });
      continue;
    }
    if (draft.summary) io.out(`\nThe agent: ${draft.summary}`);
    const pv = ctl.previewDesign(runId, draft.draftPath);
    showPreview(d, pv);
    if (pv.steps === 0) io.err("The draft has no plan steps QFB can extract; edit it, or keep your answer without it.");
    const a = await choose(
      d,
      "\n[a] apply it and continue · [e] edit the draft first · [k] keep your answer, leave the design as is · [s] stop > ",
      (x) => ["a", "e", "k", "s"].includes(x),
    );
    if (a === "s") return "stopped";
    if (a === "k") {
      await ctl.decide(runId, given);
      return "resumed";
    }
    if (a === "e") {
      await io.edit(draft.draftPath);
      continue;
    }
    if (pv.steps === 0) continue;
    await ctl.adoptDesign(runId, { hash: pv.hash, draftPath: draft.draftPath, decision: { question, answer: answerText } });
    io.out(`The design was updated: ${facts(d).designPath}`);
    return "resumed";
  }
}

/** A gate stopped the run: make sure what a person had to fix is fixed, then continue. */
async function fixGate(d: Drive, opts: ContinueOptions): Promise<Outcome> {
  const { ctl, io, runId } = d;
  if (opts.keepLocal?.length) io.out(`Kept out of the feature: ${ctl.keepLocal(runId, opts.keepLocal).join(", ")}`);
  for (;;) {
    const left = ctl.recheck(runId);
    if (left.length === 0) {
      await ctl.resume(runId);
      return "resumed";
    }
    io.out("\nStill unresolved:");
    for (const l of left) io.out(`  \u2717 ${l}`);
    if (!io.interactive) {
      io.err(`Fix the above, then run 'qfb continue ${runId}' again (or resume regardless: qfb resume ${runId}).`);
      return "waiting";
    }
    const docs = stillPresentDocs(d);
    const keep = docs.length ? `[k] keep ${docs.join(", ")} out of the feature (your docs) · ` : "";
    const a = await choose(d, `\n[r] check again · ${keep}[c] continue anyway · [s] stop > `,
      (x) => ["r", "c", "s"].includes(x) || (x === "k" && docs.length > 0));
    if (a === "s") return "stopped";
    if (a === "c") {
      await ctl.resume(runId);
      return "resumed";
    }
    if (a === "k") io.out(`Kept out of the feature: ${ctl.keepLocal(runId, docs).join(", ")}`);
  }
}

/** Orchestration-doc files of the gate blocker that are still in the change set. */
function stillPresentDocs(d: Drive): string[] {
  const b = d.ctl.blocker(d.runId);
  if (b?.kind !== "gate") return [];
  const left = d.ctl.recheck(d.runId).join("\n");
  return b.problems
    .filter((p) => p.code === "orchestration-doc")
    .flatMap((p) => p.files ?? [])
    .filter((f) => left.includes(`${f} is still in the change set.`));
}

async function vet(d: Drive, opts: ContinueOptions): Promise<Outcome> {
  const { ctl, io, runId } = d;
  if (opts.acceptUnscannable) {
    await ctl.resume(runId, { acceptUnscannable: true });
    return "resumed";
  }
  if (!io.interactive) return "waiting";
  const a = await choose(d, "\n[v] I checked them: no deny-listed content · [r] I removed that content, continue · [s] stop > ",
    (x) => ["v", "r", "s"].includes(x));
  if (a === "s") return "stopped";
  await ctl.resume(runId, a === "v" ? { acceptUnscannable: true } : {});
  return "resumed";
}
