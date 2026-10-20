# QFB Architecture

QFB is four small components (spec Section 4) plus thin supporting modules. Everything runs in one
Node process; there is no server, broker, or scheduler.

```
                 ┌──────────────────────────────────────────────┐
   CLI (index.ts)│                 Controller                    │
  doctor/init/…  │   deterministic state machine (owns rules)    │
                 │  init · advance() · gating · checkpoint ·      │
                 │  review/fix loop · recovery · pause/resume     │
                 └───────┬───────────────┬───────────────┬───────┘
                         │               │               │
               ┌─────────▼──────┐ ┌──────▼──────┐ ┌──────▼─────────┐
               │  Pi adapter    │ │ Herdr adapter│ │  State store    │
               │  (RPC/JSON)    │ │  (CLI/API)   │ │  (node:sqlite + │
               │  fresh session │ │  panes,      │ │  FS artifacts)  │
               │  → typed       │ │  observe,    │ │  atomic, locked │
               │  artifact      │ │  intervene   │ │                 │
               └────────────────┘ └─────────────┘ └─────────────────┘
                         │
               ┌─────────▼──────┐
               │ QuestDB checkout│  one writer at a time; never force-reset
               │ + review-pr /   │
               │   fix-pr skills │
               └─────────────────┘
```

## Modules

| File | Responsibility |
|------|----------------|
| `src/controller.ts` | The durable controller. Owns the lifecycle, runs `advance()` as a pure function of persisted state, gates every session, re-runs claimed validation commands, checkpoints, drives the hardening and review/fix loops, and handles pause/resume/stop/reconciliation. |
| `src/stateMachine.ts` | The validated transition table. Invalid transitions throw. Orthogonal states (`paused`/`blocked`/`failed`/`reconciliation`) are reachable from any non-terminal state and exit back to the interrupted phase (`resumeTarget`). |
| `src/store.ts` | `node:sqlite` transactional store: runs, steps, transitions, sessions (pid, outcome, consumption), checkpoints, reviews, counters, and atomic **exclusive locks** on the run and its checkout (pid+host, stale-takeover). |
| `src/procs.ts` | Process groups: every Pi session and re-run test command leads its own group, so a timeout/stop kills the whole tree and strays are reaped on exit (no overlapping writers, no concurrent Maven). Also the default `sh -c` test runner. |
| `src/plan.ts` | The preparation phase's normalizer. Extracts an ordered plan from a Markdown design/handoff doc via three strategies in priority order: `### Step N` heading-delimited steps, numbered lists, then checkboxes. Fence-aware (code blocks are opaque); keeps each step's full body. Emits QFB's canonical manifest. Preserves wording; never invents or reorders; flags ambiguity (several lists, numbering restarts, mixed list kinds) for explicit approval. |
| `src/gating.ts` | Mechanical gate (Section 6.1): objective facts only — artifact validity and identity (run, step, kind, created after the session started), the controller's REAL test exit codes vs the claims, branch/HEAD/submodule identity, scope, confidentiality (failing closed on unscannable files), orchestration-artifact hygiene. `writer` mode for code-changing sessions, `read-only` mode (tree must be unchanged) for identify/review. |
| `src/confidentiality.ts` | Frozen deny-list matching: both sides folded to lowercase letters and digits, then substring-matched, so case, separators, accents, and identifier embedding (`testTradeEventsOoo`) never hide a term. A mechanical gate, never an inference. |
| `src/report.ts` | Parses `review-pr`'s machine-readable ```qfb-review``` surface (exactly one block, unique finding IDs); **pauses on ambiguity** instead of guessing. Selects actionable findings by policy; computes acceptance. |
| `src/identity.ts` | One shared identity + no-progress mechanism, instantiated over review findings and hardening bug entries. |
| `src/git.ts` | Read-mostly Git wrapper. Snapshots branch/HEAD/dirty-fingerprint/submodule/untracked; derives changed files and the content a change adds (for the confidentiality scan). Output is independent of user Git config, unbounded by buffer size in practice (1 GiB), and every failure throws `GitError`, which pauses the run: no fallback comparison is ever substituted. Checkpoint-commit only. **No destructive commands exist in the code.** |
| `src/adapters/pi.ts` | `PiAdapter` interface + `RpcPiAdapter`. Launches a fresh session, returns structured lifecycle info and the **typed artifact** — the only trusted completion signal. Pi's session files go to `--session-dir artifacts/<run-id>/pi-sessions`, so everything a run produces lives under its artifact dir (and `qfb clean` removes it). |
| `src/adapters/herdr.ts` | `HerdrAdapter` interface + `CliHerdrAdapter`/`NullHerdrAdapter`. Pane labels, observation (never trusted as completion), output collection. |
| `src/doctor.ts` | Preflight checks (Pi/Herdr/git/sqlite/skills/execution mode). |
| `src/paths.ts` | XDG state-dir resolution; `QFB_DB` / `QFB_ARTIFACTS` overrides. |

## The one trusted completion signal

A Pi run surfaces four distinct events: *prompt accepted*, *turn ended*, *run settled*, and *logical
completion*. These are **not interchangeable**. QFB trusts only the last one, and only when it is a
durable, typed artifact on disk (`TaskArtifact`). The adapter reports process settlement; the
controller independently reads and **gates** the artifact. Terminal idleness (Herdr "done") is an
observation, never proof.

## Determinism & recovery

`advance()` chooses the next action purely from persisted state, so a crash between any two steps is
recoverable:

- **Exactly-once outcomes.** Each session row is *consumed* in the same transaction as the state
  transition that acts on its outcome. A crash before that point re-processes the outcome from the
  on-disk artifact (never relaunching the agent); after it, the outcome is never replayed — a
  resumed or retried phase always gets a fresh session id (`run-…-S1-a2`, `run-…-review-3`, …).
  Two pauses deliberately keep the outcome unconsumed so that `resume` re-gates it instead of
  relaunching the agent: a git failure while gathering evidence, and files awaiting an operator's
  confidentiality vetting. Re-approving a changed design consumes any such held outcome.
- **One writer.** Sessions record their pid (= process group). On restart, a session the previous
  controller never saw end is checked: alive → `reconciliation`, no second writer; gone → its
  partial work is preserved as evidence and the phase continues with an informed attempt. Locks
  cover both the run and the checkout.
- **Compare-and-set transitions.** Every state change is `UPDATE … WHERE state = <expected>`; a
  concurrent change is refused, never overwritten. `pause`/`stop` from another process are
  *requests* the live controller honors (pause between sessions; stop kills the session tree).
- **Budgets persist.** Attempt/iteration/session budgets count session rows, so restarts never reset
  them. Only an explicit operator retry of a `failed` run (`qfb resume`) opens a fresh, audited
  budget window.

## Why these technology choices

- **No build step / zero runtime deps.** Node ≥ 22.6 strips TypeScript types natively and ships
  `node:sqlite`. This keeps the dependency surface minimal (spec Section 1) and the tool trivially
  auditable — important when it has write access to a real repository.
- **SQLite + FS artifacts.** Transactional state with cheap atomic writes and a durable audit trail,
  stored under XDG state (outside the QuestDB tree, Section 4.4 / 7.1).
- **Adapters, not a framework.** Pi and Herdr are integrated through narrow interfaces so tests can
  mock them deterministically (Section 15) and so the live backend can be swapped once Milestone 0
  proves it.
