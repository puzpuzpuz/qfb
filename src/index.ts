#!/usr/bin/env node
import { Store } from "./store.ts";
import { Controller } from "./controller.ts";
import { RpcPiAdapter } from "./adapters/pi.ts";
import { CliHerdrAdapter, NullHerdrAdapter } from "./adapters/herdr.ts";
import { doctor } from "./doctor.ts";
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

function makeController(): Controller {
  const store = new Store(dbPath());
  const herdr = process.env.QFB_NO_HERDR ? new NullHerdrAdapter() : new CliHerdrAdapter();
  return new Controller({ store, pi: new RpcPiAdapter(), herdr, artifactRoot: artifactRoot() });
}

const HELP = `qfb — QuestDB Feature Builder

Usage:
  qfb doctor [--repo PATH]
  qfb init --repo PATH --design PATH --base REF [--deny a,b,c] [--commit] [--strict] [--level N]
  qfb approve RUN_ID
  qfb plan RUN_ID
  qfb run RUN_ID
  qfb status RUN_ID
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

  const ctl = makeController();

  switch (cmd) {
    case "init": {
      const repo = str(flags.repo), design = str(flags.design), base = str(flags.base);
      if (!repo || !design || !base) throw new Error("init requires --repo, --design, and --base");
      const deny = typeof flags.deny === "string" ? flags.deny.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const res = ctl.init({
        repoPath: repo, designPath: design, base,
        denyList: deny,
        config: {
          ...(flags.commit ? { checkpointPolicy: "commit" as const } : {}),
          ...(flags.strict ? { strictReviewPolicy: true } : {}),
          ...(typeof flags.level === "string" ? { reviewLevel: Number(flags.level) as 0 | 1 | 2 | 3 } : {}),
        },
      });
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
    case "status":
      process.stdout.write(JSON.stringify(ctl.status(requireId(_)), null, 2) + "\n");
      break;
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
