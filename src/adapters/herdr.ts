import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Herdr integration (Section 4.3): persistent terminal visibility, pane labels,
 * and operator intervention. Herdr's idle/done state is only an OBSERVATION,
 * never proof of task completion.
 */
export interface PaneLabel {
  feature: string;
  phase: string;
  stepId: string;
  reviewIteration?: number;
}

export interface HerdrAdapter {
  /** Create or reuse a labelled pane; returns a pane id. */
  ensurePane(label: PaneLabel): Promise<string>;
  /** Update a pane's display-only metadata label. */
  label(paneId: string, label: PaneLabel): Promise<void>;
  /** Observe (not trust) the agent lifecycle state for a pane. */
  observeState(paneId: string): Promise<string>;
  /** Collect recent terminal output for observability/audit. */
  readOutput(paneId: string): Promise<string>;
}

function labelText(l: PaneLabel): string {
  const parts = [l.feature, l.phase, l.stepId];
  if (l.reviewIteration !== undefined) parts.push(`rev${l.reviewIteration}`);
  return parts.join(" | ");
}

/** Real adapter shelling out to the documented `herdr` CLI. */
export class CliHerdrAdapter implements HerdrAdapter {
  async ensurePane(label: PaneLabel): Promise<string> {
    // In a real deployment this reuses a feature workspace pane. We create one
    // and tag it with display-only metadata.
    const { stdout } = await execFileAsync("herdr", ["pane", "current"]).catch(() => ({ stdout: "" }));
    const paneId = extractPaneId(stdout) ?? "pane-0";
    await this.label(paneId, label);
    return paneId;
  }

  async label(paneId: string, label: PaneLabel): Promise<void> {
    await execFileAsync("herdr", [
      "pane", "report-metadata", "--pane", paneId, "--title", labelText(label),
    ]).catch(() => undefined);
  }

  async observeState(paneId: string): Promise<string> {
    const { stdout } = await execFileAsync("herdr", ["agent", "get", paneId]).catch(() => ({ stdout: "unknown" }));
    return stdout.trim() || "unknown";
  }

  async readOutput(paneId: string): Promise<string> {
    const { stdout } = await execFileAsync("herdr", ["pane", "read", "--pane", paneId]).catch(() => ({ stdout: "" }));
    return stdout;
  }
}

function extractPaneId(s: string): string | null {
  const m = /\b(pane[-_][\w-]+)\b/.exec(s);
  return m ? m[1]! : null;
}

/** No-op adapter for environments without Herdr (and for tests). */
export class NullHerdrAdapter implements HerdrAdapter {
  async ensurePane(): Promise<string> {
    return "null-pane";
  }
  async label(): Promise<void> {}
  async observeState(): Promise<string> {
    return "unknown";
  }
  async readOutput(): Promise<string> {
    return "";
  }
}
