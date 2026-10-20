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
| `src/controller.ts` | The durable controller. Owns the lifecycle, runs `advance()` as a pure function of persisted state, performs mechanical gating, checkpoints, drives the hardening and review/fix loops, and handles pause/resume/stop/recovery. |
| `src/stateMachine.ts` | The validated transition table. Invalid transitions throw. Orthogonal states (`paused`/`blocked`/`failed`/`reconciliation`) are reachable from any active state with explicit exits. |
| `src/store.ts` | `node:sqlite` transactional store: runs, steps, transitions, sessions, checkpoints, reviews, counters, and an **exclusive run lock** (pid+host, stale-takeover). |
| `src/plan.ts` | The preparation phase's normalizer. Extracts an ordered plan from a Markdown design/handoff doc via three strategies in priority order: `### Step N` heading-delimited steps, numbered lists, then checkboxes. Emits QFB's canonical manifest. Preserves wording; never invents or reorders; flags ambiguity for approval. |
| `src/gating.ts` | Mechanical gate (Section 6.1): objective facts only — artifact presence/typing, test exit codes, branch/submodule identity, scope, confidentiality, orchestration-artifact hygiene. |
| `src/confidentiality.ts` | Frozen deny-list matching with token variants (snake/kebab/camel/nospace), case-insensitive. A mechanical gate, never an inference. |
| `src/report.ts` | Parses `review-pr`'s machine-readable ```qfb-review``` surface; **pauses on ambiguity** instead of guessing. Selects actionable findings by policy; computes acceptance. |
| `src/identity.ts` | One shared identity + no-progress mechanism, instantiated over review findings and hardening bug entries. |
| `src/git.ts` | Read-mostly Git wrapper. Snapshots branch/HEAD/dirty-fingerprint/submodule/untracked. Checkpoint-commit only. **No destructive commands exist in the code.** |
| `src/adapters/pi.ts` | `PiAdapter` interface + `RpcPiAdapter`. Launches a fresh session, returns structured lifecycle info and the **typed artifact** — the only trusted completion signal. |
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
recoverable: on restart the controller re-acquires the run lock, re-reads state, inspects Git and
existing sessions, and resumes only from a verified point. Stable operation IDs
(`run-…-S1-a1`, `run-…-review-2`, …) make retried actions idempotent — a retried controller cannot
create a duplicate logical step or a second writer. Retry budgets and no-progress history live in the
store and are **not** reset on restart.

## Why these technology choices

- **No build step / zero runtime deps.** Node ≥ 22.6 strips TypeScript types natively and ships
  `node:sqlite`. This keeps the dependency surface minimal (spec Section 1) and the tool trivially
  auditable — important when it has write access to a real repository.
- **SQLite + FS artifacts.** Transactional state with cheap atomic writes and a durable audit trail,
  stored under XDG state (outside the QuestDB tree, Section 4.4 / 7.1).
- **Adapters, not a framework.** Pi and Herdr are integrated through narrow interfaces so tests can
  mock them deterministically (Section 15) and so the live backend can be swapped once Milestone 0
  proves it.
