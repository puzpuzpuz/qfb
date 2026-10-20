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

function stepMark(status: string, spin: string): string {
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
