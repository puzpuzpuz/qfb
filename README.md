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

No compilation is required to run. Invoke it in any of these equivalent ways:

```bash
npm run qfb -- <cmd> [flags]        # always works; flags handled for you
./src/index.ts <cmd> [flags]        # executable shebang sets the right flags
qfb <cmd> [flags]                   # after `npm link`
```

> **Node 22.6–22.17:** TypeScript type-stripping is behind a flag on these
> versions, so a bare `node src/index.ts …` fails with `ERR_UNKNOWN_FILE_EXTENSION`.
> Use one of the forms above (they pass `--experimental-strip-types`), or run
> `node --experimental-strip-types src/index.ts …` directly. Node ≥ 22.18 needs
> no flag.

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
   `--yes` covers only a clear, first-time plan: an **ambiguous** plan mapping, or a design that
   **changed after approval**, always needs a human (an interactive confirmation or `qfb approve`).
   A plan with no extractable steps is never approved.
5. **Orchestrates** serial implementation → hardening → review/fix → completion.
6. **Opens a PR** for the branch if none is open (disable with `--no-pr`). It pushes only the exact
   commit the final review accepted, from a clean tree, and refuses PR text containing deny-listed
   terms. The approving review is posted on the PR as a comment (once per accepted commit; never
   when it contains a deny-listed term). Because a PR needs commits, `build` uses commit checkpoints unless you pass `--no-pr`.

While it runs, `build` shows a **self-refreshing compact progress view** — a
phase bar (implementation ▸ hardening ▸ review/fix), per-step markers
(`✓` done, spinner = active, `○` pending, `✗` failed), and the current agent
session during the later phases. The terminal tab title follows along
(`⠋ qfb run-… · implementation 2/7`), turns to `⏸ … needs you` when the run stops
for you, and goes back to your own title when QFB exits. Disable both with
`--no-progress`; on a non-TTY it prints a one-line update whenever progress changes.

**Interruptible & resumable.** `build` finds-or-creates the run for a given
`(repo, design, base)` and the controller recovers from persisted state, so if it
is interrupted (Ctrl-C, crash, machine reboot) you simply **re-run the exact same
command** and it carries on from where it stopped — never duplicating verified
work, and never starting a second writer next to a session that is still alive
(that case enters `reconciliation`). When it stops for you (an agent's question, a
rejected change, an edited design, a budget), it says why and what to do, and
`qfb continue` picks the run up again (see below).

### Useful `build` flags

- `--yes` — approve non-interactively (required for unattended runs / non-TTY).
- `--pr-base BRANCH` — PR target and base-derivation anchor (default: repo's default branch).
- `--base REF` — pin the feature base explicitly instead of deriving it.
- `--no-pr` — complete without opening a PR; `--pr-title "..."` overrides the generated title.
- `--skip-doctor` — skip preflight (not recommended for unattended runs).
- `--commit`, `--strict`, `--level N`, `--deny a,b,c` — as in `init` (see the table below).
  `--commit` is the default for `build` unless `--no-pr` is given; it requires a clean checkout.

> **PR creation is an explicit deviation** from the spec's conservative default
> (which never pushes or opens PRs). Running `qfb build` *is* that authorization,
> and it happens only as the final step after the run reaches `COMPLETED`, for the
> accepted candidate only (same branch, same HEAD, same tree, nothing uncommitted).
> Use `--no-pr`, or the granular `qfb run` (which never pushes), to keep the
> conservative behavior.

### When a run stops: `qfb continue`

Every stop records *why* in a structured form, and `qfb status` / `qfb continue` explain it with
concrete fixes (exact files, commands, and refs). `qfb continue` (from inside the checkout, the run
ID is optional) then resolves the stop in place and carries on to completion, PR included:

- **An agent hits a design question or flaw.** Agents are told not to guess: they stop with a
  question, options, and a recommendation. Pick an option or type an answer. Your answer is
  recorded and given to *every* later session (implementation, hardening, fix-pr, and review, which
  will not flag a settled decision). If the answer changes the spec, say so: **an agent drafts the
  matching design change**, you see the design diff and the resulting plan diff, and only the draft
  you approve replaces the design. Steps you already finished keep their status; changed steps run
  next.
- **You edit the design yourself** (at any time): `continue` shows the change against the approved
  version and the plan diff, and approves exactly that in one step.
- **A change was rejected by a gate.** Each problem is listed with its fix (delete a note an agent
  left, undo an agent's commit with `git reset --soft <sha>`, remove a deny-listed term, ...);
  `continue` re-checks that it is fixed before resuming. Problems a fresh attempt can fix (e.g.
  "no validation commands ran") are retried automatically.
- **A budget ran out:** retry as is, or with guidance for the agent.
- **The review's result could not be used** (no report, or no readable `qfb-review` block):
  `continue` asks before going on, then reads the same result again (fix the report by hand if you
  like), and runs a fresh review only if it still cannot be used or the checkout changed.

Without a terminal, nothing is asked: `continue` resumes when no input is needed, takes answers from
`--option N` / `--answer "..."` (`--accept-unscannable`, `--keep-local`, `--design` likewise), and
stops at the next point that needs you.

**Design docs in the checkout are fine.** Keep `HANDOFF-feature.md` next to the code if you like:
QFB keeps the run's design out of every gate, fingerprint, and commit. `--keep-local PATH` does the
same for your other notes (documents only; code is never hidden from the gates).

### Granular / recovery commands

The step-by-step commands remain available for inspection, manual control, and
recovery — `build` is a thin orchestration over exactly these:

```bash
qfb init --repo /path/to/questdb --design ./feature-design.md --base origin/master
qfb plan RUN_ID            # review the normalized manifest
qfb approve RUN_ID
qfb run RUN_ID             # drive to the next stopping point (resumes on re-run)
qfb continue [RUN_ID]      # resolve whatever stopped the run, then carry on to completion
qfb status / pause / resume / stop / logs RUN_ID
```

See [`examples/`](examples/) for a sample design document and configuration.

## How it works (the five phases)

| Phase | State(s) | What happens |
|-------|----------|--------------|
| **Preparation** | `PREPARING` | QFB reads the design/handoff doc and normalizes it into its canonical plan manifest, preserving original wording and order. Supports numbered lists, task checkboxes, **and `### Step N` heading-delimited plans**. The manifest is written to QFB's artifact store (never the checkout) and shown for approval. |
| **B — Implementation** | `IMPLEMENTING → VERIFYING_STEP → CHECKPOINTING` | One fresh Pi session per plan step. The controller mechanically gates the result, then checkpoints. One writer at a time. |
| **C — Hardening** | `HARDENING_IDENTIFY → HARDENING_WRITE_TESTS → HARDENING_FIX_BUGS` | Fresh sessions identify coverage gaps (read-only), write adversarial/fuzz/concurrency/fault-injection tests, and fix the bugs those tests expose. Every stage is gated like an implementation step. Bugs are recorded, not silently fixed; exposing tests are preserved; open bugs never reach review — they are fixed within budget or the run stops. |
| **D — Stabilization** | `REVIEWING → FIXING → VERIFYING_FIX → REVIEWING …` | QuestDB's `review-pr` runs against the cumulative diff; blocking findings go to `fix-pr`; loop until an acceptable verdict with passing test gate. |
| **E — Completion** | `COMPLETED` | Every lasting validation command accepted during the run (agents mark one-off checks such as baseline repros, which are verified when claimed but not kept) is re-run once on the reviewed candidate; only then does the run complete. `qfb run` never pushes; `qfb build` pushes the accepted commit and opens a PR (unless `--no-pr`). QFB never merges or deploys. |

Orthogonal states — `paused`, `blocked`, `failed`, `reconciliation` — preserve evidence and have
explicit recovery transitions: `qfb resume` returns to the phase that was interrupted (resuming a
`failed` run is an audited operator retry with a fresh budget window). The **controller owns every
transition rule**, never the LLM; state changes are compare-and-set, so a concurrent change is
refused rather than overwritten.

## The core safety property: two kinds of verification

- **Mechanical gating (owned by QFB).** Objective facts only: the session completed, a valid typed
  handoff artifact exists, the branch/HEAD/submodule are unchanged (agents never commit), no
  out-of-scope or confidentiality-deny-listed changes occurred, and every claimed validation command
  passes when **QFB re-runs it itself** — the real exit code decides, not the claim. Every session
  is gated: writers (implementation, hardening write/fix, fix-pr) as above; read-only sessions
  (coverage-gap identification, review) must leave the checkout byte-for-byte unchanged. A failed
  gate means the work is **not** accepted — regardless of what the agent *claimed*.
- **Semantic judgment (delegated).** Whether the code genuinely satisfies the prose acceptance
  criteria is established only by the Phase D `review-pr`/`fix-pr` loop over the cumulative diff. QFB
  never self-assesses this with heuristics or keyword matching.

An agent's `DONE` is a **claim, not a result** — it is only an input to the gate.

## CLI reference

| Command | Purpose |
|---------|---------|
| `qfb build --repo PATH --design PATH [--base REF] [--pr-base BRANCH] [--yes] [--no-pr] [--pr-title …] [--skip-doctor] [--deny …] [--commit] [--strict] [--level N]` | **One-shot, resumable orchestration**: validate → prepare → approve → run → open PR. Re-run to resume. |
| `qfb continue [RUN_ID] [--answer "..."] [--option N] [--accept-unscannable] [--keep-local PATH,...] [--design PATH] [--yes]` | Pick a run up wherever it stopped: explain why, resolve it (answer an agent's question, optionally with an agent-drafted design revision you approve; approve an edited design; re-check a gate fix; vet files; retry), then run to completion and open the PR `build` asked for. RUN_ID defaults to the unfinished run of the current checkout. |
| `qfb doctor [--repo PATH]` | Check Pi, Herdr, skills, subagents, credentials, execution-mode compatibility. |
| `qfb init --repo PATH --design PATH --base REF [--deny a,b] [--commit] [--strict] [--level N]` | Create a run; resolve `--base` to a commit SHA (the review range never drifts after a fetch); extract the plan manifest. |
| `qfb plan RUN_ID` | Print the normalized plan manifest produced by the preparation phase. |
| `qfb approve RUN_ID` | Approve the design + plan (freezes the design hash). If the design changed since the plan was extracted, it re-extracts, shows the step diff, and needs a second `approve`. Only for runs awaiting (re-)approval; it is not a resume. |
| `qfb run RUN_ID` | Execute the workflow to its next natural stopping point. |
| `qfb status RUN_ID [--verbose] [--json]` | Phase, step progress, decisions, and, for a stopped run, why it stopped and what to do. `--json` for the raw status. |
| `qfb pause / resume / stop RUN_ID` | Safe pause (a live controller pauses after its current session), reconcile-and-continue back to the interrupted phase (a `failed` run gets an audited retry), forced stop (kills the session's process tree, preserves evidence, enters `reconciliation`). |
| `qfb resume RUN_ID --accept-unscannable` | Record that you vetted the files the confidentiality scan could not read (binary, too large, unreadable); the vetting covers exactly that content. |
| `qfb logs RUN_ID` | Locate transcripts, test logs, review/fix reports. |
| `qfb list` | List known runs. |
| `qfb clean RUN_ID [--yes]` | Permanently delete a run's state-store records and its artifact directory (manifest, transcripts, Pi session files, test logs, reports, patches). Asks for confirmation unless `--yes`. Refuses while a controller or session is still live; never touches the checkout or its commits. |

Flags: `--commit` (commit-checkpoint policy instead of snapshot-only), `--strict` (resolve all
actionable findings, not just Critical), `--level N` (review level 0–3, default 2; anything else is
rejected), `--deny` (the confidentiality deny-list; terms match regardless of case and separators,
including inside identifiers: `trade_events` also catches `testTradeEventsOoo`).

## State & artifacts

Run state lives **outside** the QuestDB source tree, under your XDG state dir
(`$XDG_STATE_HOME/qfb` or `~/.local/state/qfb`): a SQLite database plus versioned filesystem
artifacts. Override with `QFB_DB` and `QFB_ARTIFACTS`. QFB's own working materials (manifests,
handoffs, reports, agents' notes in `artifacts/<run-id>/scratch/`) live there, never in the QuestDB
checkout. Your design doc may live in the checkout: QFB keeps it (and docs kept with `--keep-local`)
out of every gate, fingerprint and commit, and never edits `.gitignore` to do so. The operator's
decisions are stored per run and handed to every later session.
Pi's own session files for a run (including nested review/fix subagents) are kept in
`artifacts/<run-id>/pi-sessions/`, not in Pi's default session store.

**Cleaning up.** `qfb clean RUN_ID` deletes everything QFB keeps for a run: its rows in every
state-store table and its artifact directory. It then compacts the database (`VACUUM`), because
deleting alone leaves older copies of updated rows (deny-list terms, plan text) in free space. The
checkout, its commits, and any PR are left alone. If it is interrupted, re-running it removes
whatever files are left.

**Parallel runs.** By default every run shares one `qfb.sqlite` (runs are rows keyed by `run_id`);
only artifacts are split into per-run subdirs under `artifacts/<run-id>/`. Different features can run
concurrently against this shared DB — SQLite WAL mode gives concurrent readers plus a serialized
writer, a 5s `busy_timeout` absorbs simultaneous writes, and each controller holds an exclusive
lock on its run **and its checkout** (a second process on the *same* run, or a second run on the
*same* checkout, is refused — one writer per checkout). For full isolation, point each run
at its own store via `QFB_DB` / `QFB_ARTIFACTS` (trade-off: `list`/`status` then only see that run,
and resuming requires re-passing the same `QFB_DB`). Keep the shared DB on a local filesystem, not
NFS.

## Testing

```bash
npm test          # deterministic unit + controller integration tests (Pi/Herdr mocked)
npm run typecheck # optional, requires the TypeScript devDependency
```

The suite covers the Section 15 behaviors: serial one-writer execution, mechanical-gate rejections
(including claimed-vs-real test exit codes and HEAD movement), design-edit invalidation, gated
hardening and fix-pr stages, the review/fix loop, needs-discussion pauses, non-Clean fix outcomes,
stale-result rejection, iteration limits, finding/bug no-progress detection, the hard session
ceiling, run and checkout lock exclusivity, pause/stop from another process, resume back to the
interrupted phase, and crash recovery (a still-running session is never joined by a second writer;
an outcome is re-processed but never replayed). `test/continue.test.ts` drives the operator flows
of `qfb continue` with scripted answers: decisions reaching every later session, agent-drafted
design revisions applied only as reviewed, edited designs, gate re-checks, local docs, a missing
design, and retries with guidance. `test/procs.test.ts` exercises the real process-group handling,
the push guard, and design docs kept out of commits against real processes and a real git repo.

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
