import { execFileSync } from "node:child_process";

export interface PrResult {
  opened: boolean;
  url?: string;
  reason: string;
}

/**
 * Open a pull request for the feature branch if one is not already open.
 *
 * NOTE: spec Section 7 defaults QFB to never push or open PRs without separate
 * authorization. Invoking `qfb build` (or `--open-pr`) IS that explicit
 * authorization for the final, completed candidate only. This is deliberately
 * the last action and runs only after the run reaches COMPLETED.
 */
export function openPrIfNone(
  repoPath: string,
  branch: string,
  prBase: string,
  title: string,
  body: string,
): PrResult {
  const gh = (args: string[]): string =>
    execFileSync("gh", args, { cwd: repoPath, encoding: "utf8" });

  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    return { opened: false, reason: "gh CLI not found; skipped PR creation. Push and open the PR manually." };
  }

  // Already an open PR for this branch?
  try {
    const existing = gh(["pr", "list", "--head", branch, "--state", "open", "--json", "url"]);
    const arr = JSON.parse(existing || "[]") as { url: string }[];
    if (arr.length > 0) {
      return { opened: false, url: arr[0]!.url, reason: "an open PR already exists for this branch" };
    }
  } catch (e) {
    return { opened: false, reason: `could not query existing PRs: ${(e as Error).message.split("\n")[0]}` };
  }

  // Push the verified branch, then open the PR.
  try {
    execFileSync("git", ["push", "-u", "origin", branch], { cwd: repoPath, stdio: "inherit" });
  } catch (e) {
    return { opened: false, reason: `git push failed: ${(e as Error).message.split("\n")[0]}` };
  }

  try {
    const out = gh(["pr", "create", "--base", prBase, "--head", branch, "--title", title, "--body", body]);
    const url = out.trim().split("\n").filter(Boolean).pop() ?? "";
    return { opened: true, url, reason: "opened a new PR" };
  } catch (e) {
    return { opened: false, reason: `gh pr create failed: ${(e as Error).message.split("\n")[0]}` };
  }
}
