/**
 * Pure rendering for the self-refreshing `qfb build` progress view.
 * Kept side-effect free so it can be unit-tested in isolation.
 */

export const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
export const PHASES = ["implementation", "hardening", "review/fix"];

export interface StepView {
  id: string;
  status: string;
  attempts: number;
  text: string;
}

export interface SessionView {
  kind: string;
  stepId: string;
  status: string | null;
  endedAt: string | null;
}

export function phaseGroup(state: string): string {
  if (["IMPLEMENTING", "VERIFYING_STEP", "CHECKPOINTING"].includes(state)) return "implementation";
  if (state.startsWith("HARDENING")) return "hardening";
  if (["REVIEWING", "FIXING", "VERIFYING_FIX"].includes(state)) return "review/fix";
  return state.toLowerCase();
}

export function stepMark(status: string, spin: string): string {
  switch (status) {
    case "done":
      return "\u2713"; // ✓
    case "active":
      return spin;
    case "failed":
      return "\u2717"; // ✗
    case "blocked":
      return "\u25a3"; // ▣
    default:
      return "\u25cb"; // ○ pending
  }
}

export interface ProgressInput {
  state: string;
  sessionCount: number;
  steps: StepView[];
  currentSession: SessionView | null;
  columns: number;
  frame: number;
}

export interface TitleInput {
  runId: string;
  state: string;
  stepsDone: number;
  stepsTotal: number;
  frame: number;
}

const STOPPED = ["paused", "blocked", "failed", "reconciliation"];

/**
 * The terminal (tab) title: whether QFB is working or waiting on you, readable
 * from a background tab. The important part comes first, as tabs truncate.
 */
export function titleText(i: TitleInput): string {
  if (i.state === "COMPLETED") return `\u2713 qfb ${i.runId} \u00b7 complete`;
  if (STOPPED.includes(i.state)) return `\u23f8 qfb ${i.runId} \u00b7 needs you (${i.state})`;
  const spin = SPINNER[i.frame % SPINNER.length]!;
  return `${spin} qfb ${i.runId} \u00b7 ${phaseGroup(i.state)} ${i.stepsDone}/${i.stepsTotal}`;
}

/** Save the current title on the terminal's title stack / restore it (xterm; ignored where unsupported). */
export const TITLE_PUSH = "\x1b[22;0t";
export const TITLE_POP = "\x1b[23;0t";

/** The escape sequence (OSC 0) that sets the tab and window title, with control characters removed. */
export function titleSequence(text: string): string {
  return `\x1b]0;${text.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07`;
}

/** Build the compact progress block as an array of lines. */
export function progressLines(input: ProgressInput): string[] {
  const spin = SPINNER[input.frame % SPINNER.length]!;
  const cur = phaseGroup(input.state);
  const lines: string[] = [];

  const phaseBar = PHASES.map((p) => (p === cur ? `\u25b8 ${p}` : `  ${p}`)).join("   ");
  lines.push(`  ${phaseBar}   \u00b7   state ${input.state}   \u00b7   sessions ${input.sessionCount}`);

  for (const s of input.steps) {
    const attempt = s.status === "active" ? `  (attempt ${s.attempts})` : "";
    let line = `   ${stepMark(s.status, spin)} ${s.id}  ${s.text}${attempt}`;
    if (line.length > input.columns) line = line.slice(0, input.columns - 1) + "\u2026";
    lines.push(line);
  }

  if (cur !== "implementation" && input.currentSession) {
    const c = input.currentSession;
    const run = c.endedAt ? "done" : `${spin} running`;
    lines.push(`   ${c.kind}: step=${c.stepId} status=${c.status ?? "?"} [${run}]`);
  }
  return lines;
}
