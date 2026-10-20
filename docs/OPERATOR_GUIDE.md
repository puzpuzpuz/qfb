# QFB Operator Guide

This guide walks through running a feature from an approved design to completion, and how to
intervene and recover.

## The one-command path: `qfb build`

Most of the time you want a single, resumable command:

```bash
qfb build --repo /path/to/questdb --design ./feature-design.md \
          --deny "AcmeCorp,customer orders,trade_events" --yes
```

It runs preflight, prepares and approves the plan, orchestrates implementation 
detection → hardening → review/fix to completion, and opens a PR if none is open.

**It is interruptible and resumable.** `build` keys off `(repo, design, base)` and
resumes the existing run from its persisted state. If it is interrupted 
(Ctrl-C, crash, reboot), **re-run the identical command** — it continues from
where it stopped and never repeats verified work. If it pauses for a decision or
stops on a budget/no-progress condition, it prints the reason and the resumable
next step; fix the issue and re-run `build` (or use the granular commands below).

Without `--yes`, `build` shows the normalized manifest and prompts for approval
interactively; on a non-TTY it stops at the approval gate and tells you to pass
`--yes` or run `qfb approve`. The sections below describe the same lifecycle via
the granular commands, which `build` orchestrates.


## 0. Preflight

```bash
qfb doctor --repo /path/to/questdb
```

Every line must be `✓`. The three `repo:` checks confirm QuestDB's `CLAUDE.md` and the
`review-pr`/`fix-pr` skill files are present. A missing Pi subagent capability or skill is a
**preflight failure** — do not start an unattended run until it is resolved.

## 1. Prepare the design document

You (the developer) author and iterate the design doc in Phase A. It must contain an **ordered
implementation plan** under an "Implementation Plan" heading, in any of these shapes:

- numbered list items (`1.`, `2)`),
- task checkboxes (`- [ ]`), or
- **`### Step N — …` heading-delimited steps** (each step is a sub-heading plus its body).

During the **preparation phase** (`qfb init`), QFB reads the doc and normalizes it into its own
canonical manifest: it assigns stable IDs (`S1`, `S2`, …), preserves the original wording verbatim,
and keeps the order unchanged. It never invents or reorders steps; if the structure is ambiguous it
tells you and asks you to adjust the design and re-init. Inspect the normalized manifest with
`qfb plan RUN_ID` before approving. The manifest lives only in QFB's artifact store, never in the
QuestDB checkout.

See [`../examples/sample-design.md`](../examples/sample-design.md).

## 2. Initialize

```bash
qfb init --repo /path/to/questdb \
         --design ./feature-design.md \
         --base origin/master \
         --deny "AcmeCorp,customer orders,trade_events" \
         [--commit] [--strict] [--level 2]
```

- `--base` anchors the **review range** for the whole run; it is never narrowed to the last
  checkpoint.
- `--deny` is the **confidentiality deny-list** (Section 7.1): customer/prospect/individual names and
  customer-specific table/column/schema names that must never appear in committed code, tests,
  comments, or identifiers. It lives only in QFB's state store. Any match in a changeset fails the
  scope/integrity gate and pauses the run.
- `--commit` switches checkpoints from snapshot-only to real commits (QFB commits verified product
  code only; never pushes, rebases, or touches PR metadata).
- `--strict` makes the review loop resolve all actionable findings, not just Critical.
- `--level` sets the `review-pr` level (0–3, default 2; use 3 for especially risky changes).

## 3. Review & approve the plan

```bash
qfb status run-xxxxxxxx     # inspect the extracted steps
qfb approve run-xxxxxxxx    # freezes the design hash + plan manifest
```

Approval is explicit and authoritative. If you edit the design **after** approval, QFB detects the
hash change on the next `run`/`resume`, enters `paused`, and requires a fresh `approve` (re-approval)
before any implementation/hardening/review work may proceed.

## 4. Run

```bash
qfb run run-xxxxxxxx
```

QFB acquires an exclusive run lock, then drives: serial implementation (one fresh Pi session per
step, mechanically gated and checkpointed) → test-coverage hardening (identify gaps → write
adversarial tests → fix exposed bugs) → stabilization (`review-pr` ⇄ `fix-pr` until an acceptable
verdict with a passing test gate) → `COMPLETED`.

It runs unattended while decisions are routine. It **pauses** when it needs an architectural,
product, compatibility, scope, or safety decision, and **fails** (preserving evidence) when a budget
or no-progress condition is hit.

## 5. Monitor

```bash
qfb status run-xxxxxxxx     # phase, step progress, session count, reviews, checkpoints, blockers
qfb logs   run-xxxxxxxx     # where transcripts, test logs, and review/fix reports live
```

If Herdr is active, panes are labelled with the feature, phase, step ID, and review iteration so you
can watch live. Remember: a pane going idle is **not** proof of completion.

## 6. Intervene

- `qfb pause RUN_ID` — request a safe pause (avoids interrupting an active write where possible).
- `qfb resume RUN_ID` — reconcile (re-checks design integrity) and continue.
- `qfb stop RUN_ID` — stop while preserving the uncertain state for reconciliation.

When paused for a decision, `status` shows the `stopReason`. Inspect and, if needed, modify the
checkout yourself, then `resume`. QFB never auto-approves permission dialogs, broad scope increases,
or destructive Git actions.

## 7. Recovery after a crash

Just run `qfb run RUN_ID` (or `qfb resume`). The controller re-acquires the lock, re-reads durable
state, inspects the repository and any in-flight session, and resumes only from a verified point.
Because every logical operation has a stable ID and state transitions are atomic, a crash between
code edits and checkpointing does **not** duplicate implementation work — the inherited changes are
preserved and reconciled. Retry budgets persist across restarts.

## Stop conditions you may see

- Review returned **needs-discussion** → paused for your decision.
- `fix-pr` returned **Blocked / Diverging / Exhausted** → stopped (only *Clean* advances).
- A **stale** test/review result after the checkout changed → paused; re-run.
- The **review iteration limit** or **hard session ceiling** was reached → failed, resumable.
- The **same blocker/bug identity** survived remediation without progress → failed, evidence preserved.
- A **scope/confidentiality** violation (out-of-scope file, deny-listed name, orchestration artifact
  staged) → paused.

## Completion

On `COMPLETED`, `qfb status` reflects completed steps and review history; `qfb logs` points at the
full evidence. QFB **does not** push, open/merge PRs, or deploy — that remains your decision.
