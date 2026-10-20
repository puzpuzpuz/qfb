#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { Store } from "./store.ts";
import { Controller } from "./controller.ts";
import { Git } from "./git.ts";
import { RpcPiAdapter } from "./adapters/pi.ts";
import { CliHerdrAdapter, NullHerdrAdapter } from "./adapters/herdr.ts";
import { doctor } from "./doctor.ts";
import { openPrIfNone } from "./pr.ts";
import { State } from "./types.ts";
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

/** Shared --deny/--commit/--strict/--level parsing for init and build. */
function parseRunFlags(flags: Record<string, string | boolean>): { denyList: string[]; config: Partial<RunConfig> } {
  const denyList = typeof flags.deny === "string" ? flags.deny.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const config: Partial<RunConfig> = {
    ...(flags.commit ? { checkpointPolicy: "commit" as const } : {}),
    ...(flags.strict ? { strictReviewPolicy: true } : {}),
    ...(typeof flags.level === "string" ? { reviewLevel: Number(flags.level) as 0 | 1 | 2 | 3 } : {}),
  };
  return { denyList, config };
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
  qfb resume RUN_ID
  qfb stop RUN_ID
  qfb logs RUN_ID
  qfb list

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
      if (res.ambiguous) process.stdout.write(`! Plan is ambiguous — edit the design and re-run init.\n`);
      for (const n of res.notes) process.stdout.write(`  note: ${n}\n`);
      process.stdout.write(`Next: review the manifest (qfb plan ${res.runId}), then qfb approve ${res.runId}\n`);
      break;
    }
    case "approve":
      ctl.approve(requireId(_));
      process.stdout.write(`Approved ${_[1]}. Next: qfb run ${_[1]}\n`);
      break;
    case "plan": {
      const st = ctl.status(requireId(_));
      const p = st.preparedPlanPath as string | null;
      if (!p) { process.stdout.write(`No prepared plan for ${_[1]}.\n`); break; }
      const { readFileSync } = await import("node:fs");
      process.stdout.write(readFileSync(p, "utf8"));
      break;
    }
    case "run": {
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
    case "pause":
      ctl.pause(requireId(_));
      process.stdout.write(`Paused ${_[1]}.\n`);
      break;
    case "resume":
      ctl.resume(requireId(_));
      process.stdout.write(`Resumed ${_[1]}. Next: qfb run ${_[1]}\n`);
      break;
    case "stop":
      ctl.stop(requireId(_));
      process.stdout.write(`Stopped ${_[1]} (state preserved).\n`);
      break;
    case "logs":
      process.stdout.write(`Artifacts: ${artifactRoot()}/${requireId(_)}\n`);
      break;
    case "list": {
      const store = new Store(dbPath());
      for (const r of store.listRuns()) process.stdout.write(`${r.id}  ${r.state}  (${r.repoPath})\n`);
      break;
    }
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
    const { denyList, config } = parseRunFlags(flags);
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
  const needsApproval =
    !run.approved ||
    run.state === State.AWAITING_APPROVAL ||
    (run.state === State.PAUSED && /re-approval/i.test(run.stopReason ?? ""));
  if (needsApproval) {
    if (!flags.yes) {
      if (!process.stdin.isTTY) {
        err(`Approval required. Review 'qfb plan ${runId}', then re-run with --yes (or 'qfb approve ${runId}').`);
        process.exitCode = 1;
        return;
      }
      out(`\nReview the normalized plan with: qfb plan ${runId}`);
      const ok = await confirm(`Approve this plan and start the autonomous build of ${runId}? [y/N] `);
      if (!ok) {
        out(`Not approved. Left at AWAITING_APPROVAL; re-run 'qfb build ...' to resume.`);
        return;
      }
    }
    ctl.approve(runId);
    out(`Approved ${runId}.`);
  } else if (run.state === State.PAUSED || run.state === State.BLOCKED) {
    // Paused for a human decision or blocked on infra: do not silently resume.
    err(`Run ${runId} is ${run.state}: ${run.stopReason ?? "(no reason recorded)"}`);
    err(`Inspect/fix the checkout, then 'qfb resume ${runId}' and re-run 'qfb build ...'.`);
    process.exitCode = 2;
    return;
  }

  // 4. Orchestrate to completion (resumes from persisted state), with a
  //    self-refreshing compact progress view.
  out(`\nOrchestrating ${runId} \u2026  (Ctrl-C to interrupt; re-run 'qfb build ...' to resume)\n`);
  const state = await runWithProgress(ctl, runId, !flags["no-progress"]);
  const st = ctl.status(runId);
  out("\n" + JSON.stringify(st, null, 2));

  if (state !== State.COMPLETED) {
    err(`\nRun ${runId} stopped in state '${state}': ${st.stopReason ?? ""}`);
    err(`It is resumable \u2014 address the issue and re-run 'qfb build ...'.`);
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
    const pr = openPrIfNone(repo, run.branch, prBase, title, body);
    out(pr.opened ? `\n\u2713 Opened PR: ${pr.url}` : `\nPR: ${pr.reason}${pr.url ? ` (${pr.url})` : ""}`);
  }

  out(`\n\u2713 Feature complete: ${runId}`);
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

  const onSigint = () => {
    if (interactive) process.stdout.write("\x1b[?25h"); // restore cursor
    process.exit(130);
  };
  if (interactive) {
    process.stdout.write("\x1b[?25l"); // hide cursor
    process.on("SIGINT", onSigint);
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
      process.stdout.write("\x1b[?25h");
      process.removeListener("SIGINT", onSigint);
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
