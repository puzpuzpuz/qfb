# Milestone 0 — Integration Feasibility Record

> **Status: PARTIAL / GATE NOT YET CLOSED.** This document records what has been established about
> the installed Pi/Herdr environment and names the exact criteria that still require a live,
> opt-in integration run before an unattended production workflow may rely on a backend.

Per spec Section 16, Milestone 0 is a **blocking gate**: Milestones 1–3 build on the assumptions
proven here. The QFB controller, state store, gating, and tests (Milestones 1–3 logic) have been
implemented against a mocked interface so the gate can be closed quickly once a real QuestDB checkout
with the `review-pr`/`fix-pr` skills is available.

## What was inspected

The installed CLIs expose the surfaces QFB depends on:

- **Pi** (`pi --help`): supports `--mode text|json|rpc`, non-interactive `--print/-p`, deterministic
  session identity via `--session-id`, `--session`/`--resume`/`--fork`, `--session-dir`, and
  per-session naming (`--name`). This gives QFB (a) a structured event stream, (b) stable,
  idempotent session IDs so a retried action cannot duplicate a writer, and (c) non-interactive
  execution suitable for unattended runs.
- **Herdr** (`herdr --help`): exposes `pane` (split/read/send-text/send-keys/run/report-metadata/
  wait-output/report-agent/report-agent-session) and `agent` (list/get/read/prompt/wait/start/
  attach) subcommands plus an `api`/socket surface — enough for labelled panes, lifecycle
  observation, operator attach, and output collection.
- **git**, and Node's built-in `node:sqlite`, both present.

## Chosen primary backend

**Pi RPC/JSON (`--mode json -p --session-id …`)**, with Herdr used for *visibility and operator
intervention only* (never as a completion oracle). Rationale:

1. Structured completion/error events are available directly from Pi, satisfying the Section 4.2
   requirement to prefer a structured interface over terminal scraping.
2. `--session-id` provides the stable, idempotent operation identity the recovery design needs.
3. A single backend avoids maintaining two full execution implementations (Section 16).

The Herdr interactive-session alternative remains the documented fallback **if** a required skill
proves to depend on interactive-only Pi features; QFB already models both via the `PiAdapter`
interface, and in all cases the trusted completion signal is the durable typed `TaskArtifact`, not
terminal text.

## Exit criteria — current state

| Criterion (Section 16) | Status | Evidence / what remains |
|---|---|---|
| (a) Verified task artifact from a real Pi session | **Pending live run** | `RpcPiAdapter` writes prompts and reads the typed artifact; proven end-to-end only against the mock. Needs one real `pi --mode json -p` session that emits a `TaskArtifact`. |
| (b) Nested-subagent execution of a QuestDB skill | **Pending live run** | Requires a QuestDB checkout with `.pi/skills/review-pr` + `fix-pr` and their native subagents. `qfb doctor --repo` checks their presence; execution must be demonstrated. |
| (c) Deterministic verdict/finding extraction | **Established (contract) / pending skill confirmation** | `src/report.ts` deterministically parses a ```qfb-review``` JSON block and **pauses on ambiguity** (unit-tested). Remaining: confirm `review-pr` can emit this block, or finalize the documented parsing adapter against its stable output section. |
| (d) Durable typed completion signal, not terminal scraping | **Established (design)** | The controller trusts only the on-disk `TaskArtifact`; Herdr idle/done is treated strictly as observation. Verified in the controller tests. |

## How to close the gate

Run the opt-in integration smoke test (to be executed on a machine with the real QuestDB checkout and
skills — kept opt-in so CI never shells into Pi/Herdr):

1. `qfb doctor --repo /path/to/questdb` — all checks green, including the three skill files.
2. Launch a one-step throwaway feature whose step instructs Pi to emit a `TaskArtifact`; confirm the
   controller gates and checkpoints it.
3. Drive a `review-pr --range=<base>.. --level=2` session end-to-end (exercising nested subagents) and
   confirm a `qfb-review` block is extracted deterministically; then confirm the pause-on-ambiguity
   path with a deliberately malformed report.
4. Record the observed Pi lifecycle-event sequence and the artifact path.

If any of (a)–(d) cannot be shown, **stop and file a feasibility-failure report** naming the failing
criterion and its evidence (Section 17) rather than proceeding to an unattended run.
