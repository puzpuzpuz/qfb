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
→ hardening → review/fix to completion, and opens a PR if none is open. Because a
PR needs commits, `build` uses commit checkpoints (and therefore a clean checkout)
unless you pass `--no-pr`; it pushes only the exact commit the final review
accepted, and refuses a PR title/body containing deny-listed terms.

**It is interruptible and resumable.** `build` keys off `(repo, design, base)` and
resumes the existing run from its persisted state. If it is interrupted
(Ctrl-C, crash, reboot), **re-run the identical command** — it continues from
where it stopped and never repeats verified work. If it pauses for a decision,
stops on a budget/no-progress condition, or needs reconciliation, it prints the
reason; fix the issue, run `qfb resume RUN_ID`, and re-run `build`.

Without `--yes`, `build` shows the normalized manifest and prompts for approval
interactively; on a non-TTY it stops at the approval gate and tells you to pass
`--yes` or run `qfb approve`. `--yes` never covers an **ambiguous** plan or a
design **edited after approval**: those always need a human (the interactive
prompt, or `qfb approve`). The sections below describe the same lifecycle via
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
canonical manifest: it assigns stable IDs (`S1`, `S2`, …), preserves each step's full wording
verbatim (continuation lines, nested lists, and code blocks included), and keeps the order
unchanged. Fenced code is opaque: a `# comment` in a bash snippet is not a heading, and a `1.` in a
code block is not a step. Inspect the normalized manifest with `qfb plan RUN_ID` before approving.
The manifest lives only in QFB's artifact store, never in the QuestDB checkout.

QFB never invents or reorders steps. When the structure admits more than one reading, it still
proposes a mapping but marks the plan **ambiguous** (with a note saying why), and the plan then
needs an explicit human approval. That happens when the plan region holds several lists (say, an
"Acceptance criteria" list after the steps), when numbering restarts or repeats, or when numbered
items and checkboxes are mixed. A later list that continues the numbering (`3.` after `2.`) counts
as the same plan. Either approve the proposed mapping, or move the extra list out of the
"Implementation Plan" section and approve again.

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
  checkpoint. QFB resolves it to a commit SHA at init, so a later `git fetch` cannot move the range;
  a base that does not resolve is refused.
- `--deny` is the **confidentiality deny-list** (Section 7.1): customer/prospect/individual names and
  customer-specific table/column/schema names that must never appear in committed code, tests,
  comments, or identifiers. It lives only in QFB's state store. Matching ignores case, separators,
  and accents, and finds a term anywhere, including inside identifiers: `trade_events` catches
  `TRADE_EVENTS`, `trade-events`, `testTradeEventsOoo`, and `test_trade_events_wal`. Only what a
  change **adds** is scanned (added lines, new files, new file names), so a pre-existing occurrence
  that a change deletes or merely sits next to never pauses the run. Any match pauses the run. Very
  short terms match a lot of unrelated code; `init` warns about them.
- `--commit` switches checkpoints from snapshot-only to real commits: after every gated writer
  session (implementation step, hardening write/fix, fix-pr) QFB commits the verified tree. It
  requires a clean checkout at init (so nothing inherited is swept in), keeps deny-listed terms out
  of commit messages, and never pushes (except `build`'s final PR step), rebases, or touches PR
  metadata.
- `--strict` makes the review loop resolve all actionable findings, not just Critical.
- `--level` sets the `review-pr` level (0–3, default 2; use 3 for especially risky changes).

## 3. Review & approve the plan

```bash
qfb status run-xxxxxxxx     # inspect the extracted steps
qfb approve run-xxxxxxxx    # freezes the design hash + plan manifest
```

Approval is explicit and authoritative. A plan with no extractable steps is never approved. If you
edit the design **after** approval, QFB detects the hash change on the next `run`/`resume`, enters
`paused`, and requires a fresh `approve` (re-approval) before any implementation/hardening/review
work may proceed.

`approve` always approves the design as it is on disk, together with the steps extracted from
that exact text. If the design changed since the plan was prepared and its steps changed, `approve`
re-extracts them, prints the step diff (`+` new, `-` removed), stores the new manifest, and stops:
review it with `qfb plan`, then run `approve` again. Steps whose text is unchanged keep their
progress. New or edited steps get fresh IDs and run next, even if the run had already moved on to
hardening or review. `approve` is only for runs awaiting approval or paused by a design change;
to continue any other paused run, use `qfb resume`.

## 4. Run

```bash
qfb run run-xxxxxxxx
```

QFB acquires an exclusive run lock, then drives: serial implementation (one fresh Pi session per
step, mechanically gated and checkpointed) → test-coverage hardening (identify gaps → write
adversarial tests → fix exposed bugs) → stabilization (`review-pr` ⇄ `fix-pr` until an acceptable
verdict with a passing test gate) → `COMPLETED`.

Agents report the validation commands they ran; QFB **re-runs every one itself**, one at a time,
and gates on the real exit code (a claimed exit code that differs rejects the work). Logs land next
to the session's artifact as `*.verify-N.log`. Each accepted command joins the run's regression
suite (`artifacts/<run-id>/regression-suite.json`), which is re-run on the reviewed candidate before
the run may complete.

It runs unattended while decisions are routine. It **pauses** when it needs an architectural,
product, compatibility, scope, or safety decision, and **fails** (preserving evidence) when a budget
or no-progress condition is hit.

## 5. Monitor

```bash
qfb status run-xxxxxxxx             # phase, step progress, session count, reviews, checkpoints, blockers
qfb status run-xxxxxxxx --verbose   # also: current Pi session (id/kind/step), a tail of its live
                                    # transcript, and the recent phase transitions with timestamps
qfb logs   run-xxxxxxxx             # the artifact dir: per-session *.transcript.log, typed *.json
                                    # handoffs, and review/fix reports
```

Each live Pi session streams its stdout/stderr to `<artifact>.transcript.log`, so
`tail -f ~/.local/state/qfb/artifacts/<run-id>/*.transcript.log` gives you the raw agent output.

If Herdr is active, panes are labelled with the feature, phase, step ID, and review iteration so you
can watch live. Remember: a pane going idle is **not** proof of completion.

## 6. Intervene

- `qfb pause RUN_ID` — safe pause. If a controller is driving the run, the pause is *requested*
  and taken after the current session finishes (an active write is never interrupted); otherwise it
  is immediate.
- `qfb stop RUN_ID` — forced stop: terminates the active session's whole process tree (Pi and any
  Maven/JVM it started), saves the working-tree state to `*.interrupted.patch`, and puts the run in
  `reconciliation`. The changes themselves stay in the checkout.
- `qfb resume RUN_ID` — reconcile and continue: re-checks design integrity, refuses while any
  earlier session is still running, and returns the run to the phase it was interrupted in (shown
  as `resumeTo` in `qfb status`). Resuming a **failed** run is an explicit operator retry: failed
  steps are re-opened and the attempt/iteration/session budgets start a fresh window (recorded as an
  `operator-retry` transition). Restarting a controller never resets a budget by itself.

When paused for a decision, `status` shows the `stopReason`. Inspect and, if needed, modify the
checkout yourself, then `resume`. QFB never auto-approves permission dialogs, broad scope increases,
or destructive Git actions.

**Files the confidentiality scan cannot read.** A changed file that is binary, larger than 64 MiB,
or unreadable cannot be checked against the deny-list, so the gate fails closed: the run pauses and
names the file (`status` lists them under `unscannablePending`). Check them by hand. If they are
clean, `qfb resume RUN_ID --accept-unscannable` records your decision against each file's content
digest; the same session result is then re-checked, not redone. A later change to such a file
needs vetting again. If a file should not be there, remove it and `qfb resume RUN_ID`.

**Git failures.** If a git command fails while QFB gathers evidence (for example, the base commit is
unreachable), the run pauses with git's error instead of judging the work on partial evidence. Fix
the cause and `resume`; the interrupted session's result is re-checked, not redone.

## 7. Recovery after a crash

Just run `qfb run RUN_ID` (or re-run `build`). The controller re-acquires the lock, re-reads
durable state, and checks every session the previous controller never saw end, using the pid it
recorded:

- **Still running** (e.g. the controller was `kill -9`ed but Pi lives on): the run enters
  `reconciliation` and no second writer is started. Let it finish or `qfb stop` it, then
  `qfb resume`.
- **Gone**: its partial work is preserved (`*.interrupted.patch`) and left in the working tree, the
  session is retired, and the phase continues with a fresh attempt that is told to build on those
  changes rather than start over.

A session that finished but whose outcome was never recorded is re-processed from its on-disk
artifact, never relaunched; an outcome that *was* acted on is never replayed. On Ctrl-C/SIGTERM,
QFB terminates the session it launched before exiting. Retry budgets persist across restarts.

## Stop conditions you may see

- Review returned **needs-discussion** → paused for your decision.
- `fix-pr` returned **Blocked / Diverging / Exhausted**, or claimed *Clean* but its tests fail when
  QFB re-runs them → failed (only a verified *Clean* advances).
- A **stale** review result (the checkout changed during review) → paused; `qfb resume` reviews again.
- The **final regression run** failed on the reviewed candidate → paused with the failing commands
  and logs (if a command is obsolete, remove it from `regression-suite.json`), then `qfb resume`.
- The **review iteration limit**, a **hardening budget**, or the **hard session ceiling** was
  reached → failed; `qfb resume` grants an audited retry.
- The **same blocker/bug identity** survived remediation without progress → failed, evidence preserved.
- A **scope/integrity/confidentiality** violation (out-of-scope file, deny-listed name, orchestration
  artifact, HEAD/branch/submodule moved, a read-only stage that modified the tree) → paused. The
  reviewed candidate gets one more confidentiality check before the run completes.
- A changed file the confidentiality scan **cannot read**, or a **git command failed** → paused
  (see §6).
- An artifact that does not belong to its session (wrong `runId`, `stepId`, or `kind`, or a
  `createdAt` before the session started) → treated as no artifact, with the reason recorded.
- A review report with **zero or several** `qfb-review` blocks, or duplicate finding IDs → paused
  as ambiguous.
- A session from an earlier controller is **still running** → reconciliation.

## Completion

On `COMPLETED`, `qfb status` reflects completed steps and review history; `qfb logs` points at the
full evidence. `qfb run` **does not** push, open/merge PRs, or deploy — that remains your decision.
`qfb build` (unless `--no-pr`) pushes the accepted commit and opens a PR, nothing else. If a PR is
already open for the branch, it still pushes the accepted commit (never forced), so the PR is not
left behind.
