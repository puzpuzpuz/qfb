#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { Store } from "./store.ts";
import { Controller, DESIGN_CHANGED, PlanChangedError } from "./controller.ts";
import type { PlanInfo } from "./controller.ts";
import { Git } from "./git.ts";
import { RpcPiAdapter } from "./adapters/pi.ts";
import { CliHerdrAdapter, NullHerdrAdapter } from "./adapters/herdr.ts";
import { doctor } from "./doctor.ts";
import { openPrIfNone } from "./pr.ts";
import { State } from "./types.ts";
import { isOrthogonal } from "./stateMachine.ts";
import type { RunConfig } from "./types.ts";
import { progressLines } from "./progress.ts";
import type { StepView } from "./progress.ts";
import { dbPath, artifactRoot, stateDir } from "./paths.ts";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      // Support `--key=value` so values may themselves begin with `--`
      // (e.g. --pr-title=--wip) without being misread as another flag.
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function makeStack(): { store: Store; controller: Controller } {
  const store = new Store(dbPath());
  const herdr = process.env.QFB_NO_HERDR ? new NullHerdrAdapter() : new CliHerdrAdapter();
  const controller = new Controller({ store, pi: new RpcPiAdapter(), herdr, artifactRoot: artifactRoot() });
  return { store, controller };
}

function makeController(): Controller {
  return makeStack().controller;
}

/**
 * Exit (rather than die) on terminal signals so the process 'exit' hook in
 * procs.ts terminates the detached Pi/test process groups we own. Anything
 * that survives is detected by the next controller and reconciled.
 */
function exitOnSignals(): void {
  const codes: [NodeJS.Signals, number][] = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]];
  for (const [sig, code] of codes) process.on(sig, () => process.exit(code));
}

/** Shared --deny/--commit/--strict/--level parsing for init and build. */
function parseRunFlags(
  flags: Record<string, string | boolean>,
  defaults: { commit?: boolean } = {},
): { denyList: string[]; config: Partial<RunConfig> } {
  if (flags.deny === true) throw new Error("--deny requires a comma-separated list of terms");
  const denyList = typeof flags.deny === "string" ? flags.deny.split(",").map((s) => s.trim()).filter(Boolean) : [];
  let reviewLevel: 0 | 1 | 2 | 3 | undefined;
  if (flags.level !== undefined) {
    if (typeof flags.level !== "string" || !/^[0-3]$/.test(flags.level)) {
      throw new Error(`--level must be 0, 1, 2 or 3 (got ${flags.level === true ? "no value" : JSON.stringify(flags.level)})`);
    }
    reviewLevel = Number(flags.level) as 0 | 1 | 2 | 3;
  }
  const config: Partial<RunConfig> = {
    ...(flags.commit || defaults.commit ? { checkpointPolicy: "commit" as const } : {}),
    ...(flags.strict ? { strictReviewPolicy: true } : {}),
    ...(reviewLevel !== undefined ? { reviewLevel } : {}),
  };
  return { denyList, config };
}

function printPlanChange(diff: string[], out: (s: string) => void): void {
  out("The design changed, and with it the plan steps (+ new, - removed):");
  for (const d of diff) out(`  ${d}`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(question);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

const HELP = `qfb — QuestDB Feature Builder

One-shot (recommended):
  qfb build --repo PATH --design PATH [--base REF] [--pr-base BRANCH]
            [--deny a,b,c] [--commit] [--strict] [--level N]
            [--yes] [--no-pr] [--pr-title "..."] [--skip-doctor] [--no-progress]
      Validate everything, prepare + approve the plan, orchestrate the whole
      feature to completion, then open a PR if none is open. Interruptible and
      resumable: re-run the same command to carry on from where it stopped.

Granular / recovery commands:
  qfb doctor [--repo PATH]
  qfb init --repo PATH --design PATH --base REF [--deny a,b,c] [--commit] [--strict] [--level N]
  qfb approve RUN_ID
  qfb plan RUN_ID
  qfb run RUN_ID
  qfb status RUN_ID [--verbose]
  qfb pause RUN_ID
  qfb resume RUN_ID [--accept-unscannable]
  qfb stop RUN_ID
  qfb logs RUN_ID
  qfb list
  qfb clean RUN_ID [--yes]
      Permanently delete the run's state-store records and its artifacts
      (transcripts, Pi sessions, logs, reports). Never touches the checkout.

State store: ${stateDir()}
`;

async function main(): Promise<void> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];

  if (!cmd || cmd === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === "doctor") {
    const checks = await doctor(typeof flags.repo === "string" ? flags.repo : undefined);
    for (const c of checks) process.stdout.write(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}\n`);
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
    return;
  }

  if (cmd === "build") {
    exitOnSignals();
    await cmdBuild(flags);
    return;
  }

  const ctl = makeController();

  switch (cmd) {
    case "init": {
      const repo = str(flags.repo), design = str(flags.design), base = str(flags.base);
      if (!repo || !design || !base) throw new Error("init requires --repo, --design, and --base");
      const { denyList, config } = parseRunFlags(flags);
      const res = ctl.init({ repoPath: repo, designPath: design, base, denyList, config });
      process.stdout.write(`Created ${res.runId} with ${res.steps} step(s) [strategy: ${res.strategy}].\n`);
      process.stdout.write(`Prepared plan manifest: ${res.preparedPlanPath}\n`);
      for (const n of res.notes) process.stdout.write(`  note: ${n}\n`);
      if (res.steps === 0) {
        process.stdout.write(`! No steps could be extracted. Edit the design's Implementation Plan; 'qfb approve ${res.runId}' re-extracts it.\n`);
      } else if (res.ambiguous) {
        process.stdout.write(
          `! The plan structure is ambiguous (see the notes). Check the proposed mapping with 'qfb plan ${res.runId}': ` +
            `approve it as is, or edit the design first ('qfb approve' re-extracts it).\n`,
        );
      }
      process.stdout.write(`Next: review the manifest (qfb plan ${res.runId}), then qfb approve ${res.runId}\n`);
      break;
    }
    case "approve": {
      const id = requireId(_);
      try {
        ctl.approve(id);
      } catch (e) {
        if (!(e instanceof PlanChangedError)) throw e;
        printPlanChange(e.diff, (s) => process.stdout.write(s + "\n"));
        throw e;
      }
      if (ctl.status(id).planAmbiguous) process.stdout.write(`! Approved an ambiguous plan mapping as proposed.\n`);
      process.stdout.write(`Approved ${id}. Next: qfb run ${id}\n`);
      break;
    }
    case "plan": {
      const st = ctl.status(requireId(_));
      const p = st.preparedPlanPath as string | null;
      if (!p) { process.stdout.write(`No prepared plan for ${_[1]}.\n`); break; }
      const { readFileSync } = await import("node:fs");
      process.stdout.write(readFileSync(p, "utf8"));
      break;
    }
    case "run": {
      exitOnSignals();
      const state = await ctl.run(requireId(_));
      process.stdout.write(`Run ${_[1]} settled in state: ${state}\n`);
      process.stdout.write(JSON.stringify(ctl.status(_[1]!), null, 2) + "\n");
      break;
    }
    case "status": {
      const id = requireId(_);
      process.stdout.write(JSON.stringify(ctl.status(id), null, 2) + "\n");
      if (flags.verbose || flags.v) printStatusDetails(ctl, id);
      break;
    }
    case "pause": {
      const r = ctl.pause(requireId(_));
      process.stdout.write(
        r === "paused"
          ? `Paused ${_[1]}.\n`
          : `Pause requested for ${_[1]}; its live controller pauses once the current session finishes.\n`,
      );
      break;
    }
    case "resume": {
      const to = await ctl.resume(requireId(_), { acceptUnscannable: Boolean(flags["accept-unscannable"]) });
      process.stdout.write(`Resumed ${_[1]} -> ${to}. Next: qfb run ${_[1]} (or re-run 'qfb build ...')\n`);
      break;
    }
    case "stop": {
      const r = await ctl.stop(requireId(_));
      process.stdout.write(
        r === "stopped"
          ? `Stopped ${_[1]}; it is in reconciliation (evidence preserved). Inspect the checkout, then qfb resume ${_[1]}.\n`
          : `Stop requested for ${_[1]}; any active session was terminated and the live controller enters reconciliation.\n`,
      );
      break;
    }
    case "logs":
      process.stdout.write(`Artifacts: ${artifactRoot()}/${requireId(_)}\n`);
      break;
    case "list": {
      const store = new Store(dbPath());
      for (const r of store.listRuns()) process.stdout.write(`${r.id}  ${r.state}  (${r.repoPath})\n`);
      break;
    }
    case "clean":
    case "cleanup":
      await cmdClean(ctl, requireId(_), Boolean(flags.yes));
      break;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

/**
 * One-shot orchestration. Validates the environment, finds-or-creates the run
 * for this (repo, design, base), approves it, drives the controller to
 * completion, and opens a PR if none is open. Idempotent and resumable:
 * re-running carries on from the persisted state (the controller itself owns
 * crash recovery).
 */
async function cmdBuild(flags: Record<string, string | boolean>): Promise<void> {
  const out = (s: string) => process.stdout.write(s + "\n");
  const err = (s: string) => process.stderr.write(s + "\n");

  const repo = str(flags.repo);
  const design = str(flags.design);
  if (!repo || !design) throw new Error("build requires --repo and --design");

  const git = new Git(repo);
  const prBase = str(flags["pr-base"]) ?? git.defaultBase();
  let base = str(flags.base);
  if (!base) {
    try {
      base = git.mergeBase(prBase);
    } catch {
      throw new Error(`could not derive --base from merge-base with '${prBase}'; pass --base explicitly`);
    }
    out(`Derived feature base ${base.slice(0, 12)} (merge-base of HEAD and ${prBase}).`);
  }

  // 1. Preflight.
  if (!flags["skip-doctor"]) {
    const checks = await doctor(repo);
    for (const c of checks) out(`${c.ok ? "\u2713" : "\u2717"} ${c.name}: ${c.detail}`);
    if (checks.some((c) => !c.ok)) {
      err("\nPreflight failed. Resolve the above (or pass --skip-doctor) before an unattended run.");
      process.exitCode = 1;
      return;
    }
  }

  const { store, controller: ctl } = makeStack();

  // 2. Find-or-create the run (resumption).
  let run = store.findRun(repo, design, base);
  let runId: string;
  if (!run) {
    // A PR needs commits: unless --no-pr, checkpoints are commits of the
    // gated tree, so the pushed HEAD is exactly what was reviewed.
    const { denyList, config } = parseRunFlags(flags, { commit: !flags["no-pr"] });
    const res = ctl.init({ repoPath: repo, designPath: design, base, denyList, config });
    runId = res.runId;
    out(`Prepared ${runId}: ${res.steps} step(s) [strategy: ${res.strategy}].`);
    out(`Manifest: ${res.preparedPlanPath}`);
    if (res.ambiguous) {
      err("Plan is ambiguous; edit the design doc and re-run. Nothing started.");
      process.exitCode = 1;
      return;
    }
  } else {
    runId = run.id;
    out(`Resuming ${runId} (state: ${run.state}).`);
  }

  // 3. Approval gate (idempotent).
  run = store.getRun(runId)!;
  const reapproval = run.state === State.PAUSED && run.stopReason === DESIGN_CHANGED;
  if (run.state === State.AWAITING_APPROVAL || reapproval) {
    // Approve exactly what the design on disk says now (re-extracted if it changed).
    const plan: PlanInfo = ctl.refreshPlan(runId);
    if (plan.diff.length > 0) printPlanChange(plan.diff, out);
    for (const n of plan.notes.filter((n) => n.startsWith("AMBIGUOUS"))) out(`  ${n}`);
    if (plan.steps === 0) {
      err(`No plan steps could be extracted from ${design}; give it an ordered Implementation Plan, then re-run. Nothing started.`);
      process.exitCode = 1;
      return;
    }
    // --yes is blanket consent to a clear, first-time plan. It never covers a
    // changed design or an ambiguous mapping: those need a human to look.
    const why = reapproval ? "the approved design changed" : plan.ambiguous ? "the plan structure is ambiguous" : null;
    if (why || !flags.yes) {
      if (!process.stdin.isTTY) {
        err(
          why
            ? `Explicit approval required because ${why}; --yes does not cover this. Review 'qfb plan ${runId}', ` +
                `then 'qfb approve ${runId}' and re-run 'qfb build ...' (or edit the design and re-run).`
            : `Approval required. Review 'qfb plan ${runId}', then re-run with --yes (or 'qfb approve ${runId}').`,
        );
        process.exitCode = 1;
        return;
      }
      out(`\nReview the normalized plan with: qfb plan ${runId}${why ? `  (attention: ${why})` : ""}`);
      const ok = await confirm(`Approve this plan and start the autonomous build of ${runId}? [y/N] `);
      if (!ok) {
        out(`Not approved; nothing started. Re-run 'qfb build ...' to resume.`);
        return;
      }
    }
    ctl.approve(runId);
    out(`Approved ${runId}.`);
  } else if (isOrthogonal(run.state)) {
    // Paused, blocked, failed, or in reconciliation: never silently resume.
    err(`Run ${runId} is ${run.state}: ${run.stopReason ?? "(no reason recorded)"}`);
    err(`Inspect/fix the checkout, then 'qfb resume ${runId}' and re-run 'qfb build ...'.`);
    process.exitCode = 2;
    return;
  }
  if (!flags["no-pr"] && run.config.checkpointPolicy !== "commit") {
    out(`! ${runId} uses snapshot checkpoints: it can complete, but QFB will not push uncommitted work (use --no-pr, or start a new run).`);
  }

  // 4. Orchestrate to completion (resumes from persisted state), with a
  //    self-refreshing compact progress view.
  out(`\nOrchestrating ${runId} \u2026  (Ctrl-C to interrupt; re-run 'qfb build ...' to resume)\n`);
  const state = await runWithProgress(ctl, runId, !flags["no-progress"]);
  const st = ctl.status(runId);
  out("\n" + JSON.stringify(st, null, 2));

  if (state !== State.COMPLETED) {
    err(`\nRun ${runId} stopped in state '${state}': ${st.stopReason ?? ""}`);
    err(
      st.stopReason === DESIGN_CHANGED
        ? `Review the edited design, then re-run 'qfb build ...' to approve the updated plan.`
        : `It is resumable \u2014 address the issue, then 'qfb resume ${runId}' and re-run 'qfb build ...'.`,
    );
    process.exitCode = 2;
    return;
  }

  // 5. Open a PR if none is open (final step only).
  if (!flags["no-pr"]) {
    const title =
      str(flags["pr-title"]) ?? `feat: ${design.split("/").pop()?.replace(/\.md$/, "") ?? "feature"}`;
    const body =
      `Automated QFB run ${runId}.\n\n` +
      `- Steps completed: ${st.stepsDone}/${st.stepsTotal}\n` +
      `- Review iterations: ${st.reviews}\n` +
      `- Checkpoints: ${st.checkpoints}\n\n` +
      `See QFB artifacts at ${artifactRoot()}/${runId} for the full evidence trail.`;
    const final = store.getRun(runId)!;
    const pr = openPrIfNone(repo, git, {
      branch: final.branch,
      prBase,
      featureBase: final.baseRef,
      title,
      body,
      accepted: ctl.acceptedCandidate(runId),
      checkpointPolicy: final.config.checkpointPolicy,
      denyList: final.denyList,
    });
    out(pr.opened ? `\n\u2713 Opened PR: ${pr.url}` : `\nPR: ${pr.reason}${pr.url ? ` (${pr.url})` : ""}`);
    // Success means a PR now carries the accepted commit (a new one, or an open one we pushed to).
    if (!pr.opened && !(pr.pushed && pr.url)) process.exitCode = 3;
  }

  out(`\n\u2713 Feature complete: ${runId}`);
}

/** Delete a run's records and artifacts, after confirmation unless --yes. */
async function cmdClean(ctl: Controller, runId: string, yes: boolean): Promise<void> {
  const out = (s: string) => process.stdout.write(s + "\n");
  const { run, paths } = ctl.cleanTargets(runId);
  if (!run && paths.length === 0) throw new Error(`Unknown run ${runId}`);
  if (!yes) {
    out(run ? `Run ${runId}: ${run.state}, ${run.repoPath}` : `Run ${runId} has no records left, only files.`);
    out("This permanently deletes:");
    if (run) out(`  - its records in ${dbPath()}`);
    for (const p of paths) out(`  - ${p}`);
    out("The checkout and its commits are not touched.");
    if (run && run.state !== State.COMPLETED) {
      out(`! The run is not completed: its progress is lost, and re-running 'qfb build' starts a new run.`);
    }
    if (!process.stdin.isTTY) throw new Error("Confirmation required; re-run with --yes.");
    if (!(await confirm(`Delete ${runId}? [y/N] `))) {
      out("Nothing deleted.");
      return;
    }
  }
  const r = await ctl.clean(runId);
  out(`Cleaned ${runId}: ${r.rows} state-store row(s), ${r.removed.length} artifact dir(s) deleted.`);
  if (!r.scrubbed) {
    out(`! Another QFB process is using ${dbPath()}, so it could not be compacted: remnants of the run may stay in its free space until the next 'qfb clean'.`);
  }
}

/** Human-oriented detail for `qfb status --verbose`. */
function printStatusDetails(ctl: Controller, runId: string): void {
  const out = (s: string) => process.stdout.write(s + "\n");
  const d = ctl.statusDetails(runId);

  out("\n\u2500\u2500 current session \u2500\u2500");
  if (!d.currentSession) {
    out("  (no Pi session launched yet)");
  } else {
    const c = d.currentSession;
    const live = c.endedAt ? `ended ${c.endedAt}` : "RUNNING";
    out(`  ${c.kind}  step=${c.stepId}  status=${c.status ?? "?"}  [${live}]`);
    out(`  session-id: ${c.sessionId}`);
    if (c.transcriptPath) {
      out(`  transcript: ${c.transcriptPath}`);
      out("  \u2500 last lines \u2500");
      for (const line of tailFile(c.transcriptPath, 15)) out(`    ${line}`);
    }
  }

  out("\n\u2500\u2500 recent transitions \u2500\u2500");
  if (d.recentTransitions.length === 0) out("  (none)");
  for (const t of d.recentTransitions) {
    out(`  ${t.at}  ${t.from ?? "\u2205"} \u2192 ${t.to}  (${t.operation})`);
  }
}

function tailFile(path: string, n: number): string[] {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch {
    return ["(transcript not available yet)"];
  }
}

/** Drive ctl.run(runId) while repainting a compact progress block in place. */
async function runWithProgress(ctl: Controller, runId: string, enabled: boolean): Promise<string> {
  const interactive = enabled && Boolean(process.stdout.isTTY);
  let frame = 0;
  let drawn = 0;
  let lastSig = "";

  const paint = () => {
    const status = ctl.status(runId);
    const details = ctl.statusDetails(runId);
    if (interactive) {
      const lines = progressLines({
        state: String(status.state),
        sessionCount: Number(status.sessionCount),
        steps: (status.steps as StepView[]) ?? [],
        currentSession: details.currentSession
          ? {
              kind: details.currentSession.kind,
              stepId: details.currentSession.stepId,
              status: details.currentSession.status,
              endedAt: details.currentSession.endedAt,
            }
          : null,
        columns: process.stdout.columns ?? 80,
        frame,
      });
      let buf = "";
      if (drawn > 0) buf += `\x1b[${drawn}A`; // move to top of previous block
      buf += "\x1b[0J"; // clear everything below
      buf += lines.join("\n") + "\n";
      process.stdout.write(buf);
      drawn = lines.length;
      frame++;
    } else {
      const sig = `${status.state}|${(status.steps as StepView[]).map((s) => s.status).join("")}|${status.sessionCount}`;
      if (sig !== lastSig) {
        lastSig = sig;
        process.stdout.write(
          `  [${status.state}] steps ${status.stepsDone}/${status.stepsTotal} \u00b7 sessions ${status.sessionCount}\n`,
        );
      }
    }
  };

  // Signals exit via exitOnSignals(); restore the cursor on any exit path.
  const restoreCursor = () => process.stdout.write("\x1b[?25h");
  if (interactive) {
    process.stdout.write("\x1b[?25l"); // hide cursor
    process.on("exit", restoreCursor);
  }
  const interval = setInterval(paint, interactive ? 400 : 2000);
  interval.unref();
  paint();
  try {
    return await ctl.run(runId);
  } finally {
    clearInterval(interval);
    paint(); // final frame
    if (interactive) {
      restoreCursor();
      process.removeListener("exit", restoreCursor);
    }
  }
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function requireId(parts: string[]): string {
  const id = parts[1];
  if (!id) throw new Error(`${parts[0]} requires a RUN_ID`);
  return id;
}

main().catch((e) => {
  process.stderr.write(`Error: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
