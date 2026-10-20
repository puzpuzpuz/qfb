# QFB review handoff — open High and Medium items

**Baseline:** `5063210` ("Fix critical gating, recovery, and push-safety bugs in the controller").
All critical review items are fixed in that commit; this document hands over what remains.
Verify the baseline with `npm run typecheck && npm test` (80 tests, all passing).

Each item lists the problem, where it lives, a suggested fix, and a "done when" check. Locations
are given as file + function (line numbers drift). Suggested order is at the end.

## Already resolved by `5063210` (do not redo)

| Original item | Status |
|---|---|
| High: deny-list not applied to commit messages / PR text | Applied now (`Controller.checkpointCommit`, `openPrIfNone`), but with the weak matcher, see H1 |
| High: HEAD changes / history rewrites not gated | Fixed: the gate pauses on HEAD, branch, or submodule movement |
| High: commit mode staged the agent's self-reported files | Fixed: `Git.commitAll` commits the gated tree; commit mode requires a clean checkout |
| High: malformed artifact crashed the controller; stale artifact at the path | Fixed: `validateArtifact`; leftover files are renamed before launch |
| High: hardening handoff chain, tangled fix/pass loops, `maxHardeningTestAttempts` unused | Fixed |
| Medium: lock stale-takeover race; non-atomic state/step/transition writes | Fixed: `BEGIN IMMEDIATE` locks; outcome batches run in one transaction |
| Medium: stale review recorded before rejection | Fixed: the read-only gate pauses before anything is recorded |
| Medium: docs contradicted `build` (push / PR) | Fixed |
| Medium: `MockPi` never wrote artifacts; no Diverging/Exhausted tests | Fixed |

---

## High

### H1. Confidentiality deny-list misses realistic leaks

- **Problem.** `scanForDenyTerms` matches ``\b<variant>\b`` on lowercased text. `_` is a word character,
  and lowercasing erases camel-case boundaries. So none of these match:
  - `acmecorp_trades` or `test_trade_events_wal`: the term is embedded in a snake_case identifier.
  - `AcmeCorpIngestTest` or `testTradeEventsOoo`: the term is embedded in a camel/Pascal-case identifier.
  - `acme_corp` for the deny-term `AcmeCorp`: single-word terms get no variants.

  The camelCase variant can never match, because it contains uppercase letters while the haystack
  is lowercased. Input gaps:
  - `Git.workingDiff` skips untracked files over 512 KiB and binary files. Both fail open.
  - The scan covers removed (`-`) and context lines, so pre-existing occurrences cause false-positive pauses.

  The same matcher now guards commit messages and PR text.
- **Where.** `src/confidentiality.ts` (`tokenVariants`, `scanForDenyTerms`), `src/git.ts` (`workingDiff`).
- **Fix.**
  - Normalize both sides to lowercase alphanumerics only, and substring-match the normalized term.
    The deny-list is explicit, so accept the extra false positives.
  - Scan only added lines plus new or untracked file contents.
  - If something can't be scanned (too large, binary, or unreadable), fail closed: pause and name the file.
- **Done when.** All seven of these are caught: `class AcmeCorpIngestTest`, `"acmecorp_trades"`,
  `acme_corp_trades`, `test_trade_events_wal`, `testTradeEventsOoo`, `trade-events`, `TRADE_EVENTS`.
  A deleted line containing a term does not pause.

### H2. Large diffs wedge the run; git errors fail open

- **Problem.** `Git.run` uses `execFileSync` with the default 1 MiB `maxBuffer`.
  - Once the cumulative `git diff <base>` exceeds 1 MiB, `snapshot()` throws ENOBUFS and every step
    aborts, so the run is wedged.
  - `workingDiff` swallows the error and returns `""`, so the deny-list scan passes (fails open).
  - The controller makes it worse:
    - `safe(() => git.changedFiles(...), a?.changedFiles ?? [])` falls back to the agent's self-report.
    - `safe(() => git.workingDiff(...), "")` falls back to an empty diff.
  - On *any* error, `dirtyFingerprint`, `changedFiles` and `workingDiff` silently fall back from
    `git diff <base>` to `git diff` (working tree vs index), which is a different comparison. A
    missing base ref does this, for example.
- **Where.** `src/git.ts` (`run`, `dirtyFingerprint`, `changedFiles`, `workingDiff`);
  `src/controller.ts` (gate inputs in `doImplementationStep`, `doHardening`, `doFix`).
- **Fix.**
  - Raise `maxBuffer` to 1 GiB, or stream the diff into the hash.
  - Remove the silent fallbacks.
  - Any git failure while building gate inputs must fail the gate closed (pause, with the error).
    It must never substitute agent claims or an empty string.
- **Done when.** A 5 MiB feature diff completes a step, and a deny term inside it is still caught.
  A missing base ref pauses with a clear message.

### H3. Plan extraction silently loses or invents steps; approval doesn't re-check the plan

- **Problem.**
  - **Code fences.** A `# comment` inside a fenced code block (common in bash snippets) is parsed
    as a heading. It ends the plan region or step early, so later steps vanish. A 3-step plan came
    out as 1 step, with no ambiguity flag.
  - **List bodies.** The ordered-list strategy keeps only an item's first line. Indented prose and
    code under an item are dropped, despite the "wording preserved verbatim" claim.
  - **Stray lists.** Any top-level numbered list in the plan region becomes steps, such as an
    "Acceptance criteria" list. Numbering restarts aren't flagged, and checkbox and numbered lists
    get merged.
  - **Ambiguity.** `ambiguous` is set only when zero steps were found.
  - **Zero-step plans.** `build` refuses an ambiguous plan only when creating the run. Re-running
    `build --yes` finds the same run and approves it. `approve()` doesn't check the step count, so
    the run goes straight to hardening and review, and can complete with no implementation.
  - **Edited designs.** `approve()` re-hashes the *current* design but never re-extracts its
    steps, so editing the design and re-approving freezes the new hash with the old plan. Following
    `build`'s own advice ("edit the design doc and re-run") gives exactly that result.
  - **Auto re-approval.** `build --yes` re-approves a changed design automatically:
    `needsApproval` includes paused runs awaiting re-approval.
- **Where.** `src/plan.ts` (`extractPlan`, `extractHeadingSteps`, `extractListItems`);
  `Controller.approve`; `cmdBuild` in `src/index.ts`.
- **Fix.**
  - Use a fence-aware line scanner.
  - Keep each item's full body.
  - Flag ambiguity when there are several lists, numbering restarts, or mixed strategies.
  - Store the source hash in the manifest.
  - `approve` refuses 0 steps. If the design hash differs from the manifest's source hash, it
    re-extracts the steps, shows the step diff, and needs explicit confirmation; `--yes` must not
    cover a design change.
- **Done when.** The bash-comment plan yields 3 steps with their full text. An "Acceptance criteria"
  list is flagged as ambiguous. `build --yes` on a zero-step run refuses. Re-approving an edited
  design updates the steps or refuses.

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

### H6. Artifact identity isn't checked (rest of original High item 11; lower risk now)

- **Problem.** `validateArtifact` checks the artifact's shape but not that it belongs to this
  session. `runId`, `stepId` and `kind` aren't compared with the expected values, and `createdAt`
  isn't compared with the session start. Per-attempt paths and stale-file renaming make a mix-up
  unlikely, but the spec calls for typed, verified handoffs.
- **Where.** `src/gating.ts` (`validateArtifact`), and its callers in `src/controller.ts`.
- **Fix.** Pass the expected `{runId, stepId, kind, startedAt}` and reject mismatches as "no valid artifact".
- **Done when.** An artifact with the wrong `stepId`, `kind`, or an earlier `createdAt` fails the gate.

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

### M3. Review report parsing is lenient where it should pause

- **Problem.**
  - The first ` ```qfb-review ` block wins, so a quoted or example block earlier in the report gets
    parsed instead of the real one.
  - Duplicate finding IDs aren't detected.
  - The block is written by the LLM driving `review-pr`, not by the skill itself (spec §8.1).
  - `testGatePassed` is a boolean the agent writes itself. The controller's final regression run
    now limits the damage.
- **Where.** `src/report.ts` (`extractBlock`, `parseFindings`).
- **Fix.** Require exactly one block, otherwise treat the report as ambiguous. Reject duplicate IDs.
  Settling the surface itself belongs to Milestone 0 (M6).
- **Done when.** A report with two blocks, or with duplicate IDs, pauses as ambiguous.

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
  sequence, and adjust the adapter and timeout behaviour to match. Decide M3 (the report surface)
  and M4 (Herdr) here too.
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
- **F2. The base ref isn't resolved to a SHA.** `qfb init --base origin/master` stores the ref name.
  After a fetch, the review range, fingerprints and deny-list scan all quietly shift; spec §7 wants
  the range anchored. `build` derives a merge-base SHA, so only `init --base REF` is affected.
  Resolve the ref with `git rev-parse --verify REF^{commit}` at init, and fold this into H2's
  base-ref validation.
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
- **F7. `approve()` works on any paused run.** It re-freezes the design hash and returns to the
  paused phase even when the pause had nothing to do with the design. Using it as a resume skips
  `resume`'s open-session check; `run()` still reconciles before launching, so no second writer
  starts. Restrict `approve` to `AWAITING_APPROVAL` and to pauses caused by a design change.
- **F8. An already-open PR goes stale.** `openPrIfNone` returns the existing URL without pushing the
  newly accepted commit. Push the verified commit, then report the URL.
- **F9. CLI input validation.** `--level` isn't validated (NaN or out of range is accepted), and
  numeric config values aren't checked.

---

## Suggested order

1. **H2, then H1.** These are small, contained changes that close a run-stopping failure and two
   fail-open security holes. Fold F2 into H2.
2. **H3.** Plan fidelity: a dropped step is silent scope loss.
3. **M6 (Milestone 0) before any further large work.** It may change the backend (M4) and the report
   surface (M3), and the spec treats it as a hard gate.
4. **H4, H5, H6**, then the medium items and follow-ups as needed.
