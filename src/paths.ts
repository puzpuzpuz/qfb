import { join } from "node:path";
import { homedir } from "node:os";

/** Resolve the XDG state directory for QFB (Section 4.4: outside the source tree). */
export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".local", "state");
  return join(base, "qfb");
}

export function dbPath(): string {
  return process.env.QFB_DB ?? join(stateDir(), "qfb.sqlite");
}

export function artifactRoot(): string {
  return process.env.QFB_ARTIFACTS ?? join(stateDir(), "artifacts");
}
