# QuestDB Feature Builder (QFB)

A lightweight, durable CLI **orchestrator** for autonomous feature development in the QuestDB
repository. QFB automates QuestDB's *existing* engineering workflow — fresh Pi sessions implementing
one approved plan step at a time, test-coverage hardening, then stabilization via QuestDB's own
`review-pr` / `fix-pr` skills — while keeping strict, mechanical control over source changes, tests,
and recovery.

QFB is **not** a generic multi-agent framework. It introduces no CrewAI/AutoGen/Beads-style platform,
no database server, and no web app. It is a small TypeScript/Node CLI with a deterministic state
machine, a transactional local state store, and thin adapters over Pi and Herdr.

> **Central principle.** The controller executes a human-approved plan through trusted
> repository-specific skills. It never confuses LLM confidence, terminal idleness, or a successful
> tool invocation with verified engineering completion. It **gates on mechanical evidence it can check
> itself** and **delegates semantic judgment** to QuestDB's review skill.

## Why it exists

The manual process is: start a fresh Pi session → read the design + plan → implement the next
unfinished step with tests → validate → end session → repeat. Doing this reliably across *dozens or
hundreds* of sessions, without duplicating work after a crash or trusting an agent's unverified
"done", is what QFB automates.

## Requirements

- **Node.js ≥ 22.6** (QFB runs its TypeScript sources directly via Node's type-stripping loader and
  uses the built-in `node:sqlite` — no build step, no native modules, zero runtime dependencies).
- **Pi** on `PATH` (the coding agent; structured `--mode json/rpc` used for lifecycle events).
- **Herdr** on `PATH` (optional; persistent terminal visibility and operator intervention).
- **git**.

Check everything with:

```bash
node src/index.ts doctor --repo /path/to/questdb
# or, once linked:  qfb doctor --repo /path/to/questdb
```

## Install

```bash
git clone https://github.com/puzpuzpuz/qfb
cd qfb
npm install        # only installs the TypeScript devDependency (for `npm run typecheck`)
npm link           # optional: puts `qfb` on your PATH
```

No compilation is required to run — `node src/index.ts <cmd>` works directly.

## Quick start — one command

The headline UX is a single, resumable command that validates everything,
prepares and approves the plan, orchestrates the entire feature, and opens a PR
if none is open:

```bash
qfb build --repo /path/to/questdb --design ./feature-design.md \
          --deny "AcmeCorp,customer orders,trade_events" --yes
```

What `qfb build` does, in order:

1. **Validates** the environment (`doctor`: Pi, Herdr, skills, subagents, exec mode).
2. **Derives** the feature base from `merge-base(HEAD, --pr-base)` unless you pass `--base`.
3. **Prepares** the plan — normalizes the design/handoff doc into QFB's canonical manifest.
4. **Approves** it — interactively (shows the manifest and prompts) or non-interactively with `--yes`.
5. **Orchestrates** serial implementation → hardening → review/fix → completion.
6. **Opens a PR** for the branch if none is open (disable with `--no-pr`).

**Interruptible & resumable.** `build` finds-or-creates the run for a given
`(repo, design, base)` and the controller recovers from persisted state, so if it
is interrupted (Ctrl-C, crash, machine reboot) you simply **re-run the exact same
command** and it carries on from where it stopped — never duplicating verified
work. When it pauses for a human decision or stops on a budget, it tells you what
to fix; address it and re-run.

### Useful `build` flags

- `--yes` — approve non-interactively (required for unattended runs / non-TTY).
- `--pr-base BRANCH` — PR target and base-derivation anchor (default: repo's default branch).
- `--base REF` — pin the feature base explicitly instead of deriving it.
- `--no-pr` — complete without opening a PR; `--pr-title "..."` overrides the generated title.
- `--skip-doctor` — skip preflight (not recommended for unattended runs).
- `--commit`, `--strict`, `--level N`, `--deny a,b,c` — as in `init` (see the table below).

> **PR creation is an explicit deviation** from the spec's conservative default
> (which never pushes or opens PRs). Running `qfb build` *is* that authorization,
> and it happens only as the final step after the run reaches `COMPLETED`. Use
> `--no-pr`, or the granular `qfb run` (which never pushes), to keep the
> conservative behavior.

### Granular / recovery commands

The step-by-step commands remain available for inspection, manual control, and
recovery — `build` is a thin orchestration over exactly these:

```bash
qfb init --repo /path/to/questdb --design ./feature-design.md --base origin/master
qfb plan RUN_ID            # review the normalized manifest
qfb approve RUN_ID
qfb run RUN_ID             # drive to the next stopping point (resumes on re-run)
qfb status / pause / resume / stop / logs RUN_ID
```

See [`examples/`](examples/) for a sample design document and configuration.

## How it works (the five phases)

| Phase | State(s) | What happens |
|-------|----------|--------------|
| **Preparation** | `PREPARING` | QFB reads the design/handoff doc and normalizes it into its canonical plan manifest, preserving original wording and order. Supports numbered lists, task checkboxes, **and `### Step N` heading-delimited plans**. The manifest is written to QFB's artifact store (never the checkout) and shown for approval. |
| **B — Implementation** | `IMPLEMENTING → VERIFYING_STEP → CHECKPOINTING` | One fresh Pi session per plan step. The controller mechanically gates the result, then checkpoints. One writer at a time. |
| **C — Hardening** | `HARDENING_IDENTIFY → HARDENING_WRITE_TESTS → HARDENING_FIX_BUGS` | Fresh sessions identify coverage gaps, write adversarial/fuzz/concurrency/fault-injection tests, and fix the bugs those tests expose. Bugs are recorded, not silently fixed; exposing tests are preserved. |
| **D — Stabilization** | `REVIEWING → FIXING → VERIFYING_FIX → REVIEWING …` | QuestDB's `review-pr` runs against the cumulative diff; blocking findings go to `fix-pr`; loop until an acceptable verdict with passing test gate. |
| **E — Completion** | `COMPLETED` | A summary of steps, changes, tests, review history, and outstanding non-blocking findings. **QFB never pushes, opens/merges PRs, or deploys.** |

Orthogonal states — `paused`, `blocked`, `failed`, `reconciliation` — preserve evidence and have
explicit recovery transitions. The **controller owns every transition rule**, never the LLM.

## The core safety property: two kinds of verification

- **Mechanical gating (owned by QFB).** Objective facts only: the session completed, a typed handoff
  artifact exists, the branch/checkout identity is intact, the submodule state is intended, no
  out-of-scope or confidentiality-deny-listed changes occurred, required tests actually ran with
  captured exit codes. A failed gate means the step is **not** done — regardless of what the agent
  *claimed*.
- **Semantic judgment (delegated).** Whether the code genuinely satisfies the prose acceptance
  criteria is established only by the Phase D `review-pr`/`fix-pr` loop over the cumulative diff. QFB
  never self-assesses this with heuristics or keyword matching.

An agent's `DONE` is a **claim, not a result** — it is only an input to the gate.

## CLI reference

| Command | Purpose |
|---------|---------|
| `qfb build --repo PATH --design PATH [--base REF] [--pr-base BRANCH] [--yes] [--no-pr] [--pr-title …] [--skip-doctor] [--deny …] [--commit] [--strict] [--level N]` | **One-shot, resumable orchestration**: validate → prepare → approve → run → open PR. Re-run to resume. |
| `qfb doctor [--repo PATH]` | Check Pi, Herdr, skills, subagents, credentials, execution-mode compatibility. |
| `qfb init --repo PATH --design PATH --base REF [--deny a,b] [--commit] [--strict] [--level N]` | Create a run; extract + freeze the plan manifest. |
| `qfb plan RUN_ID` | Print the normalized plan manifest produced by the preparation phase. |
| `qfb approve RUN_ID` | Approve the frozen design + plan (freezes the design hash). |
| `qfb run RUN_ID` | Execute the workflow to its next natural stopping point. |
| `qfb status RUN_ID` | Phase, step progress, session, Git state, blockers, review iteration. |
| `qfb pause / resume / stop RUN_ID` | Safe pause, reconcile-and-continue, evidence-preserving stop. |
| `qfb logs RUN_ID` | Locate transcripts, test logs, review/fix reports. |
| `qfb list` | List known runs. |

Flags: `--commit` (commit-checkpoint policy instead of snapshot-only), `--strict` (resolve all
actionable findings, not just Critical), `--level N` (review level 0–3, default 2), `--deny` (the
confidentiality deny-list).

## State & artifacts

Run state lives **outside** the QuestDB source tree, under your XDG state dir
(`$XDG_STATE_HOME/qfb` or `~/.local/state/qfb`): a SQLite database plus versioned filesystem
artifacts. Override with `QFB_DB` and `QFB_ARTIFACTS`. QFB's own working materials (the design doc,
handoff documents, reports) are **never** committed to or `.gitignore`d in the QuestDB checkout.

## Testing

```bash
npm test          # deterministic unit + controller integration tests (Pi/Herdr mocked)
npm run typecheck # optional, requires the TypeScript devDependency
```

The suite covers the Section 15 behaviors: serial one-writer execution, mechanical-gate rejections,
design-edit invalidation, the review/fix loop, needs-discussion pauses, non-Clean fix outcomes,
stale-result rejection, iteration limits, finding/bug no-progress detection, the hard session
ceiling, and lock exclusivity.

A **real opt-in integration smoke test** against installed Pi/Herdr/QuestDB skills is the subject of
Milestone 0 — see [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md). Unit tests alone never establish
integration compatibility.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components and the Pi/Herdr integration.
- [`docs/FEASIBILITY.md`](docs/FEASIBILITY.md) — Milestone 0 feasibility record and the backend choice.
- [`docs/OPERATOR_GUIDE.md`](docs/OPERATOR_GUIDE.md) — init, approve, run, monitor, recover, stop.

## Status & limitations

This repository implements the controller, state store, plan handling, mechanical gating,
confidentiality deny-list, report/identity logic, checkpointing, CLI, and a full deterministic test
suite (**Milestone 1 complete; Milestones 2–3 logic implemented and unit-tested with mocked skills**).

The live Pi RPC and Herdr adapters are thin, documented shells around the real CLIs. Per the spec's
hard gate (Milestone 0), their end-to-end behavior with QuestDB's nested-subagent `review-pr` /
`fix-pr` skills must be proven by the opt-in integration smoke test before an unattended production
run — see `docs/FEASIBILITY.md`. Until then, treat live-backend lifecycle behavior as unverified.

## License

Apache-2.0.
