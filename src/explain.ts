/**
 * Turns why a run stopped (a Blocker) into what an operator needs: a one-line
 * title, the facts, and concrete actions with real paths and commands. Pure,
 * so `qfb status` and `qfb continue` say exactly the same thing, and tests can
 * pin it down.
 */
import { join } from "node:path";
import { stepMark } from "./progress.ts";
import type { Blocker, Decision, GateProblem } from "./types.ts";

export interface Explanation {
  /** What stopped the run, in one line. */
  title: string;
  /** The facts: the question, the files, the logs. */
  details: string[];
  /** What to do, most direct first. Commands are copy-pasteable. */
  actions: string[];
}

export interface RunFacts {
  runId: string;
  state: string;
  repoPath: string;
  designPath: string;
  stopReason: string | null;
}

/** Shell-quote a value for a copy-pasteable command. */
export function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Where in the workflow a stage/step is, for titles. */
export function where(stage: string, stepId: string): string {
  if (stage === "IMPLEMENTING") return `Step ${stepId}`;
  if (stage.startsWith("HARDENING")) return `Hardening (${stepId})`;
  if (stage === "FIXING") return "fix-pr";
  if (stepId === "final") return "The final check of the reviewed candidate";
  if (stage === "REVIEWING") return "The review";
  return stepId;
}

export function explain(run: RunFacts, b: Blocker | null): Explanation {
  const id = run.runId;
  const cont = `qfb continue ${id}`;
  const git = `git -C ${q(run.repoPath)}`;
  if (!b) {
    return { title: run.stopReason ?? `The run is ${run.state}.`, details: [], actions: [`Continue: ${cont}`] };
  }
  switch (b.kind) {
    case "decision": {
      const who = where(b.stage, b.stepId);
      const title =
        b.source === "blocked" ? `${who} is blocked and needs your input`
        : b.source === "review" ? "The review needs your decision"
        : b.source === "remediation" ? "The review cannot be fixed automatically"
        : `${who} needs your decision`;
      const details = [...b.question.split("\n")];
      b.options.forEach((o, i) => details.push(`  ${i + 1}) ${o}${b.recommended === i ? "   (recommended)" : ""}`));
      if (b.context) details.push(`Why it matters: ${b.context}`);
      if (b.evidencePath) details.push(`More: ${b.evidencePath}`);
      return {
        title,
        details,
        actions: [
          `Answer it: ${cont}  (pick an option or type an answer; an agent can then draft the matching design change for your approval)`,
          `Without a terminal: ${cont} ${b.options.length ? "--option N | " : ""}--answer "..."`,
          `Or edit the design yourself (${run.designPath}), then ${cont}`,
        ],
      };
    }
    case "gate": {
      const human = b.problems.filter((p) => p.human);
      const retry = b.problems.filter((p) => !p.human);
      const details = [
        ...human.map((p) => `✗ ${p.message}`),
        ...retry.map((p) => `· ${p.message}  (the next attempt is told; nothing for you to do)`),
      ];
      const actions = [...new Set(human.flatMap((p) => gateActions(run, p)))];
      actions.push(`Then: ${cont}  (checks your fix first)`);
      return { title: `${where(b.stage, b.stepId)} was rejected by QFB's checks`, details, actions };
    }
    case "unscannable":
      return {
        title: "Changed files could not be scanned for deny-listed terms",
        details: b.files.map((f) => `? ${f.path} (${f.reason})`),
        actions: [
          `Check them by hand. If they are clean: ${cont} --accept-unscannable`,
          `Otherwise remove the deny-listed content, then: ${cont}`,
        ],
      };
    case "design-changed":
      return {
        title: "The design changed since it was approved",
        details: [run.designPath],
        actions: [`Review the change and approve it: ${cont}  (shows the design and plan diff)`],
      };
    case "design-missing":
      return {
        title: "The design document is missing",
        details: [b.path],
        actions: [`Restore it, then: ${cont}`, `Or, if you moved it: ${cont} --design NEW_PATH`],
      };
    case "session-running":
      return {
        title: "A session from an earlier controller is still running",
        details: [`${b.sessionId} (pid ${b.pid ?? "?"} on ${b.host ?? "?"})`],
        actions: [`Let it finish, or stop it: qfb stop ${id}`, `Then: ${cont}`],
      };
    case "interrupted":
      return {
        title: "The run was stopped",
        details: b.evidence.map((e) => `Partial changes saved to ${e}`),
        actions: [`Inspect the checkout (${git} status); keep or revert the partial changes`, `Then: ${cont}`],
      };
    case "operator-pause":
      return { title: "Paused at your request", details: [], actions: [`Continue: ${cont}`] };
    case "git-error":
      return {
        title: "A git command failed, so the checkout could not be verified",
        details: [b.message],
        actions: [`Fix the cause (for example a stale .git/index.lock, or a missing ref), then: ${cont}`],
      };
    case "review":
      return {
        title: "The review result could not be used",
        details: [b.detail, ...(b.reportPath ? [`Report: ${b.reportPath}`] : [])],
        actions: [
          ...(b.reportPath
            ? [`To keep this review instead of running another, fix its qfb-review block by hand (exactly one block; verdict approve, request changes or needs discussion)`]
            : []),
          `Continue: ${cont}  (reads the review's result again; only if it still cannot be used, or the checkout changed, a fresh review runs)`,
        ],
      };
    case "stale":
      return {
        title: "The checkout changed while the review ran",
        details: [b.detail],
        actions: [`Review again: ${cont}  (avoid editing the checkout while the run is active)`],
      };
    case "regression":
      return {
        title: "The final regression run failed on the reviewed candidate",
        details: b.failing.map((t) => `✗ ${t.command}  (exit ${t.exitCode}; log: ${t.logPath})`),
        actions: [
          `Fix the cause, then: ${cont}`,
          `If a command is obsolete, remove it from ${b.suitePath}, then: ${cont}`,
        ],
      };
    case "budget":
      return {
        title: "The run gave up",
        details: [b.detail],
        actions: [
          `Retry with a fresh budget: ${cont}`,
          `Retry with guidance for the agent: ${cont} --answer "..."`,
          `If the design is the problem, edit it (${run.designPath}), then: ${cont}`,
        ],
      };
  }
}

/** What a person does about one gate problem. */
function gateActions(run: RunFacts, p: GateProblem): string[] {
  const id = run.runId;
  const git = `git -C ${q(run.repoPath)}`;
  const files = p.files ?? [];
  switch (p.code) {
    case "orchestration-doc":
      return files.flatMap((f) => [
        `If an agent wrote ${f}, delete it: rm ${q(join(run.repoPath, f))}`,
        `If ${f} is your own document, keep it out of commits: qfb continue ${id} --keep-local ${q(f)}`,
      ]);
    case "out-of-scope":
      return files.map((f) => `Revert the change to ${f}`);
    case "deny-term":
      return [`Remove "${p.term}" from ${files.join(", ")} (matched regardless of case and separators)`];
    case "unscannable":
      return [`Check ${files.join(", ")} by hand; if clean: qfb continue ${id} --accept-unscannable`];
    case "head-moved":
      return [`An agent committed. Undo the commit, keeping its changes: ${git} reset --soft ${p.expected ?? "HEAD~1"}`];
    case "branch-changed":
      return [`Switch back: ${git} switch ${q(p.expected ?? "")}`];
    case "submodule-moved":
      return p.expected
        ? [`Restore the submodule: ${git}/java-questdb-client checkout ${p.expected}`]
        : [`Restore the java-questdb-client submodule to its earlier state`];
    case "read-only-modified":
      return [`A read-only session changed the checkout: inspect ${git} status and revert what it changed`];
    default:
      return [];
  }
}

/** Status as `qfb status` and `qfb continue` print it. */
export interface StatusView {
  runId: string;
  state: string;
  repoPath: string;
  branch: string;
  baseRef: string;
  designPath: string;
  localDocs: string[];
  steps: { id: string; status: string; attempts: number; text: string }[];
  stepsDone: number;
  stepsTotal: number;
  sessionCount: number;
  checkpoints: number;
  reviews: number;
  decisions: Decision[];
  pendingRequests: string[];
}

export function renderStatus(st: StatusView, why: Explanation | null): string[] {
  const out: string[] = [];
  out.push(`${st.runId}  ${st.state}`);
  out.push(`  checkout   ${st.repoPath}  (branch ${st.branch}, base ${st.baseRef.slice(0, 12)})`);
  const designRel = st.localDocs.find((d) => join(st.repoPath, d) === st.designPath);
  out.push(`  design     ${st.designPath}${designRel ? "  (in the checkout; kept out of commits)" : ""}`);
  const others = st.localDocs.filter((d) => d !== designRel);
  if (others.length) out.push(`  kept local ${others.join(", ")}`);
  const marks = st.steps.map((s) => `${stepMark(s.status, "\u25d0")} ${s.id}`).join("  ");
  out.push(`  steps      ${marks || "(none)"}    ${st.stepsDone}/${st.stepsTotal} done`);
  out.push(`  sessions   ${st.sessionCount} \u00b7 checkpoints ${st.checkpoints} \u00b7 reviews ${st.reviews}`);
  if (st.decisions.length) {
    const last = st.decisions[st.decisions.length - 1]!;
    out.push(`  decisions  ${st.decisions.length} (latest, at ${last.stepId}: ${firstLine(last.answer)})`);
  }
  if (st.pendingRequests.length) out.push(`  requested  ${st.pendingRequests.join(", ")}`);
  if (why) out.push("", ...renderExplanation(why));
  return out;
}

export function renderExplanation(why: Explanation): string[] {
  const out = [`\u23f8 ${why.title}`];
  for (const d of why.details) out.push(`  ${d}`);
  if (why.actions.length) {
    out.push("", "What to do:");
    for (const a of why.actions) out.push(`  \u2192 ${a}`);
  }
  return out;
}

function firstLine(s: string): string {
  const l = s.split("\n")[0] ?? "";
  return l.length > 80 ? `${l.slice(0, 79)}\u2026` : l;
}
