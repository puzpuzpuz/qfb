# QFB review handoff — open High and Medium items

**Baseline:** `d957ca9` ("Close fail-open gaps in gating, plan approval, and PR push").
All critical items were fixed in `5063210`; `d957ca9` fixed H1, H2, H3, H6, M3, F2, F7, F8 and F9.
This document hands over what remains. Verify the baseline with `npm run typecheck && npm test`
(107 tests, all passing).

Each item lists the problem, where it lives, a suggested fix, and a "done when" check. Locations
are given as file + function (line numbers drift). Suggested order is at the end.

## Already resolved (do not redo)

### By `5063210`

| Original item | Status |
|---|---|
| High: deny-list not applied to commit messages / PR text | Fixed (`Controller.checkpointCommit`, `openPrIfNone`); the matcher itself was fixed by H1 |
| High: HEAD changes / history rewrites not gated | Fixed: the gate pauses on HEAD, branch, or submodule movement |
| High: commit mode staged the agent's self-reported files | Fixed: `Git.commitAll` commits the gated tree; commit mode requires a clean checkout |
| High: malformed artifact crashed the controller; stale artifact at the path | Fixed: `validateArtifact`; leftover files are renamed before launch |
| High: hardening handoff chain, tangled fix/pass loops, `maxHardeningTestAttempts` unused | Fixed |
| Medium: lock stale-takeover race; non-atomic state/step/transition writes | Fixed: `BEGIN IMMEDIATE` locks; outcome batches run in one transaction |
| Medium: stale review recorded before rejection | Fixed: the read-only gate pauses before anything is recorded |
| Medium: docs contradicted `build` (push / PR) | Fixed |
| Medium: `MockPi` never wrote artifacts; no Diverging/Exhausted tests | Fixed |

### By `d957ca9`

| Item | How it was fixed |
|---|---|
| H1. Deny-list misses realistic leaks | `foldForMatch` folds both sides to lowercase letters and digits and substring-matches (`src/confidentiality.ts`). The gate scans `Git.addedContent`: added lines, new/untracked file contents, and non-deleted paths. Removed and context lines are never scanned. Binary, oversized (> 64 MiB) and unreadable files fail closed and are named. `qfb resume --accept-unscannable` vets them, bound to each file's content digest (`unscannable-*` counters). A final scan of the reviewed candidate runs before `COMPLETED`. |
| H2. Large diffs wedge the run; git errors fail open | `Git` uses a 1 GiB `maxBuffer` and config-independent diff flags, and has no fallbacks. Failures throw `GitError`. `Controller.run` turns that into a pause and keeps the session outcome for re-gating on resume (`holdOutcome`). The `safe(...)` substitutions are gone (`writerEvidence`). |
| H3. Plan extraction loses or invents steps; approval doesn't re-check | Fence-aware extractor that keeps full step bodies; several lists, numbering restarts and mixed list kinds are flagged ambiguous. The source hash is stored (`plan-source-hash`, also in the manifest header). `approve` refuses 0 steps and re-extracts a changed design (`replan`): unchanged steps keep their progress, new or edited steps get fresh ids, and a changed plan needs a second `approve` (`PlanChangedError`). `build --yes` doesn't cover an ambiguous plan or a re-approval. |
| H6. Artifact identity not checked | `checkArtifact` compares `runId`, `stepId`, `kind` (per `ARTIFACT_KIND`), and `createdAt` (5 s slack) against the session. Prompts state the exact values. The rejection reason reaches the gate failure. |
| M3. Lenient review-report parsing | Exactly one `qfb-review` block; duplicate finding ids are ambiguous. (The report *surface* is still an M6 decision.) |
| F2. Base ref not resolved to a SHA | `init` stores `baseRef` = SHA and `baseSpec` = the ref as given; `findRun` matches either. A ref that doesn't resolve is refused. |
| F7. `approve()` worked on any paused run | Only `AWAITING_APPROVAL`, or `paused` with the design-change reason. Re-approval consumes held outcomes, and goes to `IMPLEMENTING` when the new plan has unfinished steps. |
| F8. An already-open PR went stale | `openPrIfNone` pushes the accepted commit first, then reuses or opens the PR. |
| F9. CLI/config validation | `--level` must be `0`–`3`; `validateConfig` rejects unknown keys and out-of-range values; deny terms with no letters or digits are refused, and very short ones get a warning. |

---

## High

### H4. No baseline snapshot at init; a dirty checkout is adopted silently in snapshot mode

- **Problem.** Spec §7 requires recording, at init:
  - branch, base, and HEAD;
  - tracked changes and untracked files;
  - submodule state;

  and adopting a dirty checkout only with explicit approval. Only the branch is recorded.

  Commit mode now refuses a dirty checkout, but snapshot mode (the `init`/`run` default) adopts one
  silently. Inherited changes are then:
  - attributed to agents by the gate (scope and deny-list false positives);
  - included in the evidence and the review range;
  - impossible to tell apart later.
- **Where.** `Controller.init`.
- **Note (since `d957ca9`).** The deny-list scan reads `Git.addedContent` (added lines and new files
  vs base) and the scope check reads `Git.changedFiles`. Baseline exclusion belongs in those two places.
- **Fix.**
  - Snapshot at init and persist it, together with a baseline patch.
  - A dirty checkout requires an explicit `--adopt-dirty`, shown at approval.
  - Exclude baseline files from gate attribution, or require them unchanged.
- **Done when.** `init` on a dirty tree without `--adopt-dirty` refuses. With the flag, the baseline
  is recorded and inherited changes never trip the gate.

### H5. Infrastructure failures burn the agent's attempt budget; `maxInfraRetries` is unused

- **Problem.** Spec §9 asks for different recovery policies for:
  - agent failure;
  - infrastructure/session failure;
  - failed validation;
  - an unresolved design decision;
  - an uncertain outcome.

  Today, Pi crashes, spawn errors (e.g. `pi` not on PATH), inactivity timeouts and aborted sessions
  all count as gate failures, so they consume `maxImplAttemptsPerStep` and the hardening budgets.
  `maxInfraRetries` is never read.
- **Where.** `src/controller.ts` (the post-session handling in each `do*` handler); `RunConfig`.
- **Note (since `d957ca9`).** `validateConfig` checks `maxInfraRetries` (integer >= 0), but nothing
  reads it yet. `GateInput.artifactProblem` says why an artifact was rejected; use it to tell "no
  artifact" apart from "wrong artifact".
- **Fix.**
  - Classify each failure:
    - no artifact plus an abnormal exit or a timeout: infrastructure, with its own counter bounded
      by `maxInfraRetries`;
    - spawn failure: `blocked` immediately;
    - artifact present and gate failed: agent or validation failure.
  - Record the category in the transition evidence.
- **Done when.**
  - A timed-out session doesn't use up the step's attempts.
  - `pi` missing from PATH blocks the run, with a clear reason.
  - Exhausting the infra budget stops the run with an infrastructure stop reason.

---

## Medium

### M1. No-progress detection rarely fires in practice

- **Problem.** `findingIdentity` and `bugIdentity` hash the normalized *evidence* or *repro* text.
  A fresh LLM review rewords these every time, so identities almost never match and the
  no-progress stop seldom triggers. The review iteration limit ends up doing that job instead.
  Short IDs like `F1` also get reused across reviews for unrelated findings.
- **Where.** `src/identity.ts`.
- **Fix.** Build identity from stable attributes: file plus symbol or line bucket, severity, and the
  finding's category or title. Alternatively, have `review-pr` emit stable fingerprints. Keep free
  text out of the identity.
- **Done when.** The same defect, reported with reworded evidence in two reviews, is detected as no-progress.

### M2. Lock and liveness checks trust pid + hostname only

- **Problem.**
  - A lock held by another host is always treated as stale and taken over. With a shared DB on NFS,
    that means two controllers.
  - pid reuse, especially after a reboot, can make a stale lock look live, so it's refused until
    that unrelated process exits.
  - The same pid reuse affects session liveness, causing false `reconciliation` entries. That's the
    safe direction, but it needs an operator.
- **Where.** `src/store.ts` (`acquireLock`, `isPidAlive`); `RpcPiAdapter.isRunning`.
- **Fix.** Store the boot id (`/proc/sys/kernel/random/boot_id`) and the process start time with
  each pid. Refuse locks held by other hosts unless an explicit `--take-over` flag is given.
- **Done when.** A lock from a previous boot is taken over, a live lock from another host is
  refused, and a reused pid isn't mistaken for the original process.

### M4. Herdr integration is cosmetic

- **Problem.**
  - `CliHerdrAdapter.ensurePane` labels `herdr pane current` (the controller's own pane, falling
    back to `pane-0`).
  - Pi doesn't run in a Herdr pane.
  - `observeState` and `readOutput` are never called.
  - The operator can't attach to the agent, which spec §4.3 asks for.
- **Where.** `src/adapters/herdr.ts`; `Controller.launchSession`.
- **Fix.** Run Pi in a dedicated, labelled Herdr pane (`herdr pane run`), or stream the transcript
  into one. This is a Milestone 0 decision (M6).
- **Done when.** During a run, `herdr` shows a pane per session, labelled with the feature, phase,
  step and review iteration.

### M5. Test-suite gaps against spec §15

These scenarios are still untested or unenforced:
- **Missing subagent capability → preflight failure.** Nothing implements this. `doctor`'s comment
  claims a subagent check, but there isn't one (see M7).
- **No concurrent Maven.** Stray reaping is tested in `test/procs.test.ts`, but nothing asserts
  outright that two Maven runs never overlap.
- **Inherited changes stay protected in snapshot mode** (depends on H4).
- **`build`'s approval gate** (`cmdBuild`: `--yes` refuses ambiguous plans and re-approvals) is only
  exercised by hand; the controller side (`refreshPlan`, `approve`) is tested.
- **A hardening test that exposed a bug is preserved and not weakened.** There's no mechanical
  check. Deleting the test is partly caught, because Surefire fails when `-Dtest=` matches nothing.
  Weakening its assertions isn't caught at all. Consider comparing file digests of the exposing
  tests between the write and fix stages.
- **The real, opt-in integration smoke test** against the installed Pi, Herdr and QuestDB skills.

### M6. Milestone 0 is still open (spec §16 hard gate)

- **Problem.** `docs/FEASIBILITY.md` records criteria (a) and (b) as unproven. `RpcPiAdapter` is
  built on unverified assumptions:
  - that the prompt arrives over stdin with `--print`;
  - that the `--mode json`, `--session-id` and `--name` flags behave as assumed;
  - that Pi exits once the run settles;
  - that nested subagents work for `review-pr`/`fix-pr` in this mode.

  The 30-minute inactivity timer could also kill a legitimate long Maven run if JSON mode prints
  nothing while a tool is running.
- **Fix.** Run the opt-in smoke test described in `docs/FEASIBILITY.md`. Record the observed event
  sequence, and adjust the adapter and timeout behaviour to match. Decide the report surface (the
  part of M3 that `d957ca9` left open: who writes the `qfb-review` block) and M4 (Herdr) here too.
- **Done when.** All four feasibility criteria are marked as established, with evidence.

### M7. `doctor` doesn't check what the spec requires

- **Problem.** There's no check for subagent capability or credentials. The "Pi RPC/JSON mode"
  check is just a regex against `--help`. `qfb run` never runs `doctor` (`build` does, unless
  `--skip-doctor` is passed).
- **Where.** `src/doctor.ts`.
- **Fix.** Probe the subagent tooling the skills need, check credentials, and run `doctor` from `run`
  (with a flag to skip it).
- **Done when.** Missing subagent support makes `doctor` fail, and `run` refuses to start without
  passing it.

---

## Follow-ups found while fixing the critical items (not in the original review)

- **F1. Scope enforcement is minimal.**
  - `allowedPathPrefixes` is always `[]`, so per-step scope (spec §6.1) is never enforced.
  - `FORBIDDEN_PATHS` has false positives: any `.gitignore` edit, and any product path containing
    `handoff` or `coverage-gap`.
  - It has false negatives: a copy of the design doc under another name passes. Comparing new files
    against the design and handoff content hashes would catch it.
- **F3. Commit-mode crash window.** `Git.commitAll` runs before the outcome transaction. A crash in
  between replays the outcome, and the gate then sees HEAD moved and pauses. That's safe, but it
  needs an operator. Record the checkpoint intent (parent + message) before committing, and accept
  a HEAD matching that intent on replay.
- **F4. `stop` can't kill tests the controller is re-running.** The process groups started by
  `verifyTests` and `runRegressionSuite` aren't recorded, so `qfb stop` from another terminal only
  takes effect at the next loop boundary. Ctrl-C does kill them, via the exit hook. Record the
  active test pgid and terminate it in `stop()`.
- **F5. Cost and trust of re-running tests.**
  - Every claimed command is re-run, so a claimed full `mvn test` costs hours twice.
  - Commands are agent-supplied strings run through `sh -c`. That's no more access than the agent
    already has, but the controller is now executing artifact content.
  - Options: an allow-list of command shapes, deduplication across a step's retries, and an
    optional controller-owned `requiredTestCommands`.
  - An obsolete command in `regression-suite.json` can only be removed by editing the JSON by hand;
    add a `qfb suite` command.
- **F6. Sessions on other hosts, and sessions with no recorded pid.**
  - `RpcPiAdapter.isRunning` returns `true` for another host's session. Reconciliation can't be
    cleared from this host, and `stop` can't kill that session.
  - It returns `false` when no pid was recorded (assumed never spawned).
  - Document this, or add an audited `qfb resume --force`.

## Follow-ups found while fixing `d957ca9`

- **F10. Upgrading runs that are in flight.**
  - The dirty fingerprint now includes binary content and streams large untracked files, so its
    values changed. A review in progress across the upgrade can pause as "modified the checkout"
    (resume re-reviews). A run that completed before the upgrade, but whose PR was not pushed yet,
    refuses the `build` push ("tree no longer matches").
  - List-strategy steps now keep their full bodies. Re-approving an edited design for a run approved
    before the upgrade shows multi-line steps as edited (`-`/`+`). Accepting that re-runs them.
  - Both are one-time; starting a new run avoids them.
- **F11. Unscannable vetting is per file content, recorded on resume.** There's no way to list or
  revoke vetted files apart from the `unscannable-accepted` counter and the transition evidence.
  Consider a `qfb status` section and a `--revoke`.
- **F12. Very short deny terms.** Substring matching makes a 2-character term (e.g. a customer called
  `HP`) flag `http`/`php`. `init` only warns. If this bites, add an opt-in whole-word mode per term.

---

## Suggested order

1. **M6 (Milestone 0) before any further large work.** It may change the backend (M4) and the report
   surface (M3's format), and the spec treats it as a hard gate.
2. **H4, H5**, then the medium items and follow-ups as needed. H5's failure classification depends
   on how Pi really exits and times out, which M6 establishes.
