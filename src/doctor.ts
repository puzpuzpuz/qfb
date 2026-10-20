import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * `qfb doctor` (Section 12): check Pi, Herdr, project skills, subagent
 * capabilities, and execution-mode compatibility. Missing Pi subagent
 * capabilities must cause preflight failure (Section 15).
 */
export async function doctor(repoPath?: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push(await probe("pi", ["--help"], "Pi CLI", /Usage:\s+pi/i));
  checks.push(await probe("herdr", ["--help"], "Herdr CLI", /herdr/i));
  checks.push(await probe("git", ["--version"], "Git", /git version/i));

  // Node built-in SQLite.
  try {
    await import("node:sqlite");
    checks.push({ name: "node:sqlite", ok: true, detail: "available (state store backend)" });
  } catch (e) {
    checks.push({ name: "node:sqlite", ok: false, detail: `unavailable: ${(e as Error).message}` });
  }

  // Structured execution mode availability.
  checks.push(await probe("pi", ["--help"], "Pi RPC/JSON mode", /--mode\s+<mode>/i, "needed for structured completion events"));

  if (repoPath) {
    checks.push(await fileCheck(repoPath, "CLAUDE.md"));
    checks.push(await fileCheck(repoPath, ".pi/skills/review-pr/SKILL.md"));
    checks.push(await fileCheck(repoPath, ".pi/skills/fix-pr/SKILL.md"));
  }

  return checks;
}

async function probe(cmd: string, args: string[], name: string, re: RegExp, note = ""): Promise<DoctorCheck> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    const ok = re.test(stdout) || re.test(stderr);
    return { name, ok, detail: ok ? `found${note ? ` — ${note}` : ""}` : `found but unexpected output` };
  } catch (e) {
    return { name, ok: false, detail: `missing: ${(e as Error).message.split("\n")[0]}` };
  }
}

async function fileCheck(repoPath: string, rel: string): Promise<DoctorCheck> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const ok = existsSync(join(repoPath, rel));
  return { name: `repo:${rel}`, ok, detail: ok ? "present" : "missing — required QuestDB skill/instruction" };
}
