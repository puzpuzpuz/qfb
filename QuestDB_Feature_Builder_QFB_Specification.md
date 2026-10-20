# Build QuestDB Feature Builder (QFB) — a durable Pi/Herdr development orchestrator

## 1. Objective

Implement a lightweight, reliable CLI orchestrator named **QuestDB Feature Builder (QFB)** for
autonomous feature development in the QuestDB repository.

The tool must automate an *existing* engineering workflow, not replace it with a generic
multi-agent development framework.

The available agent tooling is:

- **Pi** — the coding agent, with project-specific skills and extensions.
- **Herdr** — terminal/session management, monitoring, and agent automation.
- **Git** and standard local development tooling.
- QuestDB's existing `review-pr`, `fix-pr`, and other repository-specific Pi skills.

Do not introduce frameworks such as CrewAI, AutoGen, Gas City, Beads, or another task
orchestration platform.

Prefer a small standalone TypeScript/Node.js CLI and a minimal number of dependencies. No database
server, message broker, or web application is required.

The main requirement is **reliable autonomous progress across many fresh Pi sessions**, potentially
dozens or hundreds, while maintaining strict control of source-code changes, testing, and recovery.

## 2. Existing engineering workflow

### Phase A — Human-controlled design

A developer prepares a feature design document containing:

- Requirements and desired behavior.
- Architecture and technical decisions.
- A detailed, ordered implementation plan.
- Test expectations and acceptance criteria.

The design document is revised and reviewed repeatedly before implementation begins.

The orchestrator starts only after the developer explicitly approves the design and implementation
plan. The approved document is authoritative. Agents must not silently change the architecture,
requirements, or implementation plan.

If implementation reveals a genuine major design problem, the orchestrator must pause, document the
issue, and request a decision. For less critical design problems — limited to implementation-detail
choices that do not alter the plan, scope, architecture, or requirements — the orchestrator can make
the most sound decision on its own, but when the work is done it must notify the developer about each
such case. Anything that would change a plan step, scope, interface contract, or architectural
decision is a major design problem and must pause.

### Phase B — Serial implementation

The current manual process is:

1. Start a new Pi session in the QuestDB checkout.
2. Read the design document and implementation plan.
3. Identify the next unfinished implementation step.
4. Implement that step, including appropriate tests.
5. Validate the work and update progress.
6. End the session.
7. Start a fresh Pi session for the next step.
8. Repeat until all implementation steps are complete.

The orchestrator must automate this exact pattern.

Only one top-level implementation agent may modify the QuestDB checkout at a time. A step may involve
several tool calls or internal agent operations, but the next implementation step must not begin
until the previous step has been accepted.

### Phase C — Test coverage hardening

Once all implementation steps are accepted, and before stabilization, the orchestrator runs a
bounded test-hardening cycle whose goal is to *break* the feature the way a real user (and real
hardware) would, not to chase a naive line-coverage number. The focus is on adversarial, realistic
scenarios rather than mechanical 100% LoC coverage.

The cycle has three agent stages, each in its own fresh Pi session, each producing a durable, typed
handoff artifact:

1. **Identify weak spots.** A fresh Pi session analyzes the cumulative feature diff and the existing
   test suite and writes a *coverage-gap handoff document* describing concrete, prioritized testing
   weaknesses. Areas of main focus:
   - Fuzz / property-based tests over the feature's inputs and state space.
   - Concurrency tests (parallel readers/writers, races, contention, ordering).
   - More variations of the feature itself (edge values, boundary conditions, degenerate inputs).
   - Integration with existing QuestDB features — e.g. Parquet partitions, column tops (coltops),
     partition conversions, WAL, replication, out-of-order ingestion, and similar interactions.
   - Combinations of the above with simulated OS/hardware failures (I/O errors, partial writes,
     crashes mid-operation, disk-full, power-loss ordering).
   Each identified gap must be specific and testable, with a rationale for why it matters. The
   document does not modify code or tests.

2. **Write the missing tests.** A fresh Pi session implements the tests described in the coverage-gap
   handoff, respecting QuestDB's build/test rules (no concurrent Maven invocations, correct
   submodule handling). These tests are expected to *expose* defects. If a test reveals a genuine
   bug, the agent records it in a *bug handoff document* — with a stable bug ID, reproduction, the
   failing test, observed vs. expected behavior, and evidence — rather than silently fixing it or
   deleting/weakening the test. Newly added tests and the bugs they expose are both preserved.

3. **Fix the found bugs.** For each confirmed bug in the bug handoff document, a fresh Pi session
   fixes the underlying defect (not the test) and validates that the previously failing test now
   passes without regressing others. Fixes that require an architectural, compatibility, or product
   decision must pause the workflow rather than being resolved unilaterally.

The controller gates this phase on mechanical evidence (handoff artifacts exist and are typed, tests
actually ran with captured exit codes, no unauthorized scope changes, Git/submodule integrity
intact). Whether a reported weakness is worth testing, or whether a fix genuinely resolves a defect,
is validated by the tests themselves and ultimately by Phase D's review loop — the controller does
not self-assess test adequacy.

The phase is bounded: support configurable limits on gap-identification passes, test-writing
attempts, and bug-fix iterations. A newly added test that keeps failing after the fix budget is
exhausted, or a bug whose fix is Blocked/Diverging/Exhausted, stops normal progression and preserves
the evidence. A distinct no-progress condition applies when the same bug identity recurs across fix
attempts. Writing tests, exposing bugs, and fixing them is a one-writer activity like implementation:
only one agent may modify the checkout at a time, and a stage must not begin until the previous
stage's artifact has been verified.

### Phase D — Stabilization

Once implementation and test hardening are complete:

1. Start a fresh Pi session and invoke QuestDB's `review-pr` skill against the cumulative feature diff.
2. Capture and preserve the complete review report.
3. Examine the review verdict and admitted findings.
4. If blocking issues remain, start a new Pi session with the `fix-pr` skill, supplying the relevant
   findings.
5. Validate the resulting code and tests.
6. Start another fresh Pi session and repeat `review-pr`.
7. Continue until the review no longer reports blocking issues, or until a configured stop condition
   is reached.

The default acceptance policy is **no admitted Critical findings and a passing review test gate**.
Nonblocking Moderate and Minor findings may remain; preserve and report them. Allow an optional
stricter policy that attempts to resolve all actionable findings.

A review outcome requiring an architectural, compatibility, product, or other human decision must
pause the workflow.

### Phase E — Completion

The feature is complete only when:

- Every implementation-plan step has been verified.
- The test-coverage-hardening cycle has completed, with its added tests passing and all confirmed
  bugs either fixed or explicitly reported as blocking.
- Required implementation and integration tests pass.
- The latest review covers the current feature revision.
- The review returns an acceptable verdict.
- No blocking remediation obligations remain.
- The final Git state is understood and documented.

Produce a summary containing completed steps, changes, tests, review history, outstanding
nonblocking findings, limitations, and any decisions requiring attention.

Do not automatically push code, create or merge PRs, or deploy anything.

## 3. QuestDB-specific integration

Before implementation, inspect the actual repository instructions and installed Pi environment.
Read at least:

- `CLAUDE.md`
- `.pi/skills/review-pr/SKILL.md`
- `.pi/skills/fix-pr/SKILL.md`
- Relevant Pi subagent configuration and extension documentation.

Do not reimplement these skills or simplify their internal procedures.

### Review integration

Use the existing `review-pr` skill, which accepts a GitHub PR identifier or a local Git range, as
well as review levels 0–3. For local feature development, prefer the equivalent of:

```
/skill:review-pr --range=<feature-base>.. --level=2
```

Use the exact invocation supported by the installed Pi version. Capture the complete output,
including findings, supporting evidence, coverage information, and final verdict.

Default to level 2 for stabilization. Support configurable review levels, including a final level-3
review for especially risky changes.

Do not replace QuestDB's review process with generic LLM code-review prompts.

### Fix integration

Invoke the existing `fix-pr` skill using actual findings from the preceding review. Preserve finding
IDs, severities, context, evidence, and source-revision information.

The skill owns its internal investigation, independent design review, implementation, testing, and
final integration review. Do not launch a competing fixer while this skill is running. Respect its
one-writer rules and prohibition on staging, committing, pushing, changing branches, or modifying PR
metadata.

The orchestrator may perform separately authorized Git checkpoint operations only after the skill
has completed and the checkout has been verified.

Recognize the skill's distinct exit outcomes, including **Clean**, **Blocked**, **Diverging**, and
**Exhausted**. Only **Clean** may advance the normal workflow.

### Subagents

Both skills depend on Pi's existing native subagent capabilities. The builder must load the normal
project and user Pi configuration, with the necessary subagent and related tools available. Do not
disable extensions or replace native subagent execution with an incompatible external process.
Perform a compatibility check before starting an unattended run.

### Build and testing

Respect QuestDB's `CLAUDE.md` and its specific Java, Maven, Rust, native-code, and submodule
requirements.

- Never run multiple Maven test invocations concurrently in the same checkout.
- Treat `java-questdb-client/` as a separate Git repository with its own state and history.
- Do not automatically dismiss failing tests as flaky, pre-existing, or unrelated without evidence.
- Do not introduce generic build commands that disregard the repository instructions.

## 4. Architecture

Implement four small components.

### 4.1 Durable controller

A deterministic state machine owns the lifecycle of a feature run. It must decide what action
happens next based on persisted state and verified evidence, not on an LLM's memory of previous
conversations.

The controller is responsible for:

- Selecting the next pending implementation step.
- Launching Pi sessions.
- Monitoring session completion.
- Verifying reported outcomes.
- Recording progress and checkpoints.
- Starting review and fix cycles.
- Enforcing retry limits and stop conditions.
- Pausing for human intervention.
- Recovering from crashes.

The controller must not itself behave as an autonomous planning agent.

### 4.2 Pi execution adapter

Each logical implementation step, external review, or external fix operation runs in a fresh Pi
session.

Prefer a structured execution interface such as Pi RPC or JSON event mode, rather than parsing
terminal text, **provided this mode is proven to support all required QuestDB skills and their
nested subagent operations** (see Section 16, Milestone 0). Pi exposes structured completion and
error events. Use them when available.

In particular, distinguish:

- A prompt being accepted.
- An agent turn ending.
- An agent run reaching a settled state.
- A logical workflow actually satisfying its completion contract.

**These are not interchangeable.** The completion signal the controller trusts is the last one — the
logical completion contract — and it must be derived from an explicit, machine-readable artifact
(see Section 6), never inferred from any of the first three.

Do not assume RPC or noninteractive compatibility. Prove it with an integration test involving the
actual QuestDB subagent mechanisms.

If a required skill depends on interactive Pi features not supported by RPC, implement an interactive
Pi backend controlled through Herdr, with a minimal Pi extension or another reliable structured
mechanism for recording logical completion. The chosen mechanism must produce a durable, typed
completion record on disk (not terminal text). Do not base correctness on scraping terminal text.

### 4.3 Herdr integration

Use Herdr for persistent terminal visibility, agent/session management, and operator intervention.
The operator should be able to inspect the running feature workflow using Herdr.

Use the documented Herdr CLI or socket API for:

- Creating a feature workspace or reusable panes.
- Launching or displaying Pi activity.
- Observing agent lifecycle state.
- Attaching to active sessions.
- Collecting relevant terminal output.
- Showing a blocked state or need for intervention.

Where possible, label panes with the feature, current phase, step ID, and review iteration.

**Herdr's idle/done state is only an observation, not proof of successful task completion.** The
authoritative decision comes from structured Pi events, completed task artifacts, Git state, and
independent validation. Herdr session restoration must not be confused with task-level recovery.

Never resend a prompt automatically when its original delivery is uncertain. Reconcile the existing
session and filesystem state first.

### 4.4 Persistent state store

Use SQLite or a similarly reliable transactional local store, together with versioned filesystem
artifacts. Store run state outside QuestDB's tracked source tree, for example under the user's XDG
state directory.

Persist:

- Run ID and configuration.
- Repository path, branch, and feature-base revision.
- Approved design path and content hash.
- Frozen implementation-plan manifest.
- Current phase and step status.
- Pi session identity and Herdr pane identity.
- In-flight operation identity and ownership.
- Git state before and after each operation.
- Test commands, exit codes, and log paths.
- Review reports, findings, and verdicts.
- Fix reports and remediation outcomes.
- Retry counters, limits, and stop reasons.
- Timestamped state transitions.

State changes must be atomic. Use exclusive locking so two controller instances cannot accidentally
execute the same feature run simultaneously.

## 5. Implementation-plan handling

The design document contains the implementation plan. Do not require the developer to replace it with
a separate task-management system. Support conventional ordered Markdown plans, including numbered
steps, headings, and task checkboxes.

During initialization:

1. Read the implementation plan.
2. Extract its ordered steps.
3. Assign stable step identifiers.
4. Create a normalized execution manifest preserving the original wording.
5. Show the manifest for approval.
6. Freeze it before execution.

If the structure is ambiguous, produce a proposed mapping and require approval. Do not silently
invent or reorder tasks.

Keep task status in the orchestrator's state store rather than repeatedly rewriting the approved
design document. Store the approved design's hash. If the document changes after approval, pause
execution until the developer explicitly approves a new revision and reconciles affected steps.

The controller chooses steps deterministically according to the approved sequence and any explicitly
defined dependencies. Do not silently introduce new implementation steps. Small subtasks within an
approved step are allowed; material changes in scope require approval.

## 6. Implementation-step contract

Every implementation session receives a compact, self-contained instruction containing:

- The path to the approved design.
- The complete description and acceptance criteria of the selected step.
- A brief summary of already completed steps.
- Relevant architectural constraints.
- Current repository revision and state.
- Required tests.
- The output artifact path.
- Explicit prohibitions on changing other plan steps or starting another implementation step.

The agent must:

1. Read the required QuestDB instructions.
2. Reconstruct the relevant context from repository files.
3. Implement only the assigned logical step.
4. Add or update appropriate tests.
5. Execute relevant validation.
6. Record actual changes, test evidence, and limitations.
7. Return an explicit status: `DONE`, `BLOCKED`, `NEEDS_DECISION`, or `FAILED`.

These statuses are **claims, not automatically trusted results.** The controller maps each claimed
status onto an owned controller state only *after* mechanical gating (Section 6.1):

| Agent-claimed status | Controller action (after mechanical gates) |
|----------------------|--------------------------------------------|
| `DONE`               | If all mechanical gates pass → `VERIFYING_STEP`/`CHECKPOINTING`; if any gate fails → remain the active step (bounded continuation/correction) or `failed` once the attempt budget is exhausted. |
| `BLOCKED`            | → `blocked` (infrastructure/dependency obstacle); preserve evidence, await reconciliation or retry per Section 9. |
| `NEEDS_DECISION`     | → `paused` (requires human architectural/product/scope/safety decision per Section 10). |
| `FAILED`            | → bounded retry while attempts remain; otherwise `failed`. |

A claimed `DONE` never advances on the claim alone; the status is only an input to the gate, not a
substitute for it.

### 6.1 Two kinds of verification

The controller must separate what it can verify **mechanically** from what requires **semantic
judgment**, and never conflate the two. This distinction is the core safety property of QFB: the
controller gates on mechanical facts and delegates semantic judgment to QuestDB's review skill. It
never attempts to decide, on its own, that prose acceptance criteria were "met."

**Mechanical gating (owned by the controller).** Before a step may leave the active state, the
controller independently verifies objective facts from the filesystem, Git, and process state:

- The session completed and was not aborted.
- A valid, typed task handoff artifact exists at the expected path.
- The expected Git branch and checkout identity are intact.
- No unauthorized file or repository changes occurred (scope is limited to what the step permits).
- The submodule (`java-questdb-client/`) state is consistent and intended.
- Every required validation command actually ran, with captured exit codes and logs.
- Required tests passed (real exit status, not a claimed one), with no concurrent Maven invocations.
- The reported status artifact is internally consistent with the above evidence.

A step that fails any mechanical gate is **not** marked done, regardless of the agent's claimed
status. The controller may trigger a bounded continuation or correction attempt, but the step
remains the active step.

**Semantic judgment (delegated, never self-assessed).** Whether the code genuinely satisfies the
step's prose acceptance criteria — correctness, completeness, design fit — is not something the
controller evaluates by reading output or trusting the agent. Mechanical gating lets a step advance;
genuine acceptance of the *feature* is established only by the Phase D `review-pr`/`fix-pr` loop
(Section 8) over the cumulative diff. The controller must not approximate semantic acceptance with
heuristics, keyword matching, or its own LLM judgment at step granularity.

The next step always receives a fresh context, not the accumulated conversation history.

## 7. Checkpoints and Git safety

At initialization, record the feature branch, base revision, HEAD, tracked changes, untracked files,
and submodule state.

Prefer starting from a clean checkout. Support adopting a dirty checkout only with explicit approval
and a complete baseline snapshot. Preserve all inherited changes.

**Never automatically use destructive Git commands** such as hard reset, clean, or force checkout.

After a successfully verified step, create a durable checkpoint. Support two checkpoint policies:

- **Snapshot-only:** preserve exact diffs, relevant untracked content, file digests, test evidence,
  and state without committing.
- **Commit:** only when explicitly authorized for the feature run; commit verified code using
  QuestDB's commit-message conventions.

Automatic commits must be performed by the controller, not by `review-pr` or `fix-pr`, and only when
scope and Git integrity checks pass. Do not modify Git history, push, rebase, or update PR metadata
without separate authorization.

The review range must remain anchored to the original feature base. Do not accidentally narrow it to
the last implementation checkpoint.

For all test and review evidence, record the exact candidate identity, including dirty-tree and
relevant untracked-content fingerprints where applicable. Results from an older candidate must not be
accepted after source changes.

### 7.1 Orchestration-artifact hygiene and confidentiality

The orchestrator and its agents must keep QFB's own working materials out of the QuestDB repository.
These files are temporary scaffolding, not product source:

- The design/specification document and the approved implementation plan.
- Every intermediate handoff document (implementation-step handoffs, coverage-gap handoffs, bug
  handoffs, review/fix reports, and similar).

Rules:

- **Never stage, commit, or otherwise check these files into the QuestDB repo.** They are disposable
  and belong only to QFB's own state store/artifact directory (outside the tracked source tree, per
  Section 4.4).
- **Do not add them to `.gitignore` either.** Because they live outside the checkout and are
  throwaway, they must not leave any trace — not a tracked file, and not an ignore-rule entry — in the
  QuestDB repository.
- Only genuine product code and tests may be committed (and only under the Git-safety rules above).
  A checkpoint or commit that would include a spec or handoff file fails the scope/integrity gate.

**Confidentiality.** Design documents often reference a customer, prospect, or user — either a company or an
individual. That identity must never appear in the source code or tests. The same
applies to customer-specific table schema names: do not reproduce a customer's real table, column, or
schema names in committed code, tests, comments, or identifiers. Use neutral, generic names instead.
The orchestrator must treat leakage of such names into committed artifacts as a scope/integrity
violation and surface it rather than committing it.

To keep this a **mechanical** gate rather than a semantic judgment (consistent with Section 6.1), the
controller must not attempt to *infer* which names are sensitive. Instead, at `init` the developer
supplies — or the controller extracts from the design document for explicit confirmation — a
**confidentiality deny-list**: the concrete customer/prospect/individual identifiers and the
customer-specific table, column, and schema names that must never appear in committed artifacts. The
controller then matches this frozen deny-list (case-insensitively, including common token variants)
against every staged diff, new/changed file, and commit message during the scope/integrity gate. Any
match fails the gate and pauses the run. The deny-list is itself orchestration-confidential: it lives
only in the state store and must never be written into the QuestDB checkout or `.gitignore`.

## 8. Review/fix control loop

After every implementation step is accepted, enter stabilization. Use the following logic:

1. Launch a fresh Pi review session.
2. Invoke `review-pr` on the cumulative feature diff.
3. Persist the complete raw report.
4. Extract and validate its final verdict and actionable findings.
5. Associate the report with the exact reviewed candidate.
6. If the report requests a human decision, pause.
7. If it approves with no blocking issues and required tests pass, finish.
8. Otherwise, select the authorized actionable findings.
9. Launch a fresh Pi session invoking `fix-pr`.
10. Wait until the skill and all required internal work are complete.
11. Verify the skill's outcome and preserve its artifacts.
12. Run any additional required validation.
13. Start another fresh review session.

Default remediation scope: admitted Critical issues and blocking test-coverage obligations. Allow a
configuration option to include actionable Moderate and Minor findings. Never pass unrelated Adjacent
findings as automatically authorized fix work.

### 8.1 Structured report contract

The extraction layer must preserve the full evidence supporting each selected finding. If it cannot
confidently identify the verdict or finding boundaries, **pause instead of making an arbitrary
decision.**

To make extraction reliable rather than best-effort text scraping, the orchestrator requires a
stable, machine-readable report surface from `review-pr`:

- A typed final verdict (e.g., approved / blocking / needs-discussion).
- A list of findings, each with a stable finding ID, severity, location, and supporting evidence.

If the installed `review-pr` emits only prose, treat establishing this structured surface as a
prerequisite (handled in Milestone 0): either a documented structured-output mode of the skill, or a
thin, well-tested adapter that parses a documented, stable section of its output. The orchestrator
must never *guess* finding boundaries; ambiguity is a pause condition, not a heuristic.

### 8.2 Termination and no-progress detection

The review/fix loop must not terminate merely because a review contains fewer issues than the
previous review. It terminates successfully only after an acceptable verdict on the **latest
candidate** and satisfied test gates.

To detect "the same unresolved blocker repeatedly survives remediation," the controller tracks
finding **identity** across iterations (using the stable finding IDs plus location/evidence
fingerprints from Section 8.1). A blocker that recurs across remediation attempts without its
identity being retired counts as no progress, even if the total finding count drops.

This is the same no-progress mechanism applied to Phase C's **bug identity** (Section 2, Phase C):
one shared identity-tracking pattern, instantiated over two artifact types — review findings here and
bug-handoff entries in hardening — governed by the same configurable no-progress limit.


Stop if:

- A review returns *needs discussion*.
- `fix-pr` returns `Blocked`, `Diverging`, or `Exhausted`.
- A required test cannot be validated.
- The same unresolved blocker repeatedly survives remediation without meaningful progress.
- The review iteration limit is reached.
- A critical infrastructure problem remains unresolved.
- Git or design integrity checks fail.

Do not automatically accept an incomplete review because a maximum iteration count has been reached.

## 9. Crash recovery and idempotency

Recovery is a first-class requirement, not an optional enhancement. The controller must withstand
interruption between any two operations.

On restart:

1. Acquire the run lock.
2. Read the durable state and last transition.
3. Inspect the current repository and Git state.
4. Inspect existing Pi sessions/processes and Herdr panes.
5. Check whether the in-flight operation is still running.
6. Reconcile any completed artifacts and recorded events.
7. Determine whether it is safe to continue.
8. Resume only from a verified state.

Never blindly repeat a code-writing task whose previous execution may have partially succeeded. If a
Pi session is still performing legitimate work, reconnect or continue observing it rather than
creating another writer. If a session exited after editing code but before checkpointing, preserve
the changes and enter a reconciliation state.

Use stable operation IDs so a retried controller action cannot accidentally create a duplicate
logical step or conflicting session.

Distinguish:

- Agent execution failure.
- Infrastructure/session failure.
- Failed code validation.
- Unresolved design decision.
- Uncertain execution outcome.

Apply different recovery policies to these categories. Automatic retries must be bounded and
persisted. Do not reset retry budgets merely because the controller restarts.

## 10. Human intervention

The orchestrator should run unattended when decisions are routine and evidence is sufficient. It must
pause when it needs architectural, product, compatibility, scope, or safety decisions.

Provide a clear explanation of:

- What was attempted.
- What failed or requires a decision.
- Which files and revisions are affected.
- The available evidence and logs.
- Safe options for continuing.

Allow the developer to inspect and modify the checkout, then explicitly reconcile changes before
resuming. Provide commands to pause, resume, inspect, and stop runs.

A graceful pause should avoid interrupting an active write if it can safely finish. A forced stop
must record the uncertain state and require reconciliation. Do not silently approve permission
dialogs, broad scope increases, or destructive actions.

## 11. Resource and iteration limits

Support configurable limits for:

- Maximum implementation attempts per step.
- Maximum review/fix iterations.
- Maximum infrastructure retries.
- Per-session inactivity and execution timeouts.
- Overall runtime or spending budget where reliable usage data is available.
- A **mandatory hard ceiling on total Pi sessions per run**, always enforced as a fallback even when
  runtime/spend usage data is unavailable, so an unattended run cannot launch unbounded sessions.
- Maximum consecutive iterations without progress.

A timeout is not proof of task failure or proof that a prompt was never delivered. After a timeout,
inspect existing execution state and preserve partial work before deciding on recovery. If the limit
is exhausted, stop in a resumable state with a clear report.

## 12. Command-line interface

Provide a minimal CLI with commands equivalent to:

- `qfb doctor` — check Pi, Herdr, project skills, subagent capabilities, credentials, repository
  prerequisites, and execution-mode compatibility.
- `qfb init --repo PATH --design PATH --base REF` — create a feature run and proposed plan manifest.
- `qfb approve RUN_ID` — explicitly approve the frozen design and plan.
- `qfb run RUN_ID` — execute the workflow.
- `qfb status RUN_ID` — show current phase, progress, session, Git state, blockers, and review
  iteration.
- `qfb pause RUN_ID` — request a safe pause.
- `qfb resume RUN_ID` — reconcile and continue.
- `qfb stop RUN_ID` — stop while preserving evidence.
- `qfb logs RUN_ID` — locate session transcripts, tests, review reports, and fixes.

Optionally support `qfb step` and `qfb review` for manually executing exactly one step or review
round.

Make the interface usable both from a regular terminal and within Herdr. Keep the implementation
configurable but avoid introducing an unnecessary configuration language or large plugin
architecture.

## 13. Observability and artifacts

For every logical session, save:

- Prompt sent to Pi.
- Pi session identifier.
- Structured lifecycle events where available.
- Final agent response.
- Machine-readable task outcome.
- Git state and diff summary.
- Test commands, logs, and exit statuses.
- Result-validation decision.
- Duration and token usage when available.
- Failure reason if applicable.

For review/fix sessions, additionally preserve the complete raw review and remediation reports.

Provide a concise human-readable project summary and a machine-readable run status. Ensure logs do
not accidentally expose API keys, authentication tokens, or other secrets.

A developer must be able to understand why the system advanced, paused, or rejected an agent's
claimed success.

## 14. State machine

Implement explicit, validated transitions resembling:

```
CREATED → AWAITING_APPROVAL → READY → IMPLEMENTING → VERIFYING_STEP → CHECKPOINTING
        → IMPLEMENTING ...
        → HARDENING_IDENTIFY → HARDENING_WRITE_TESTS → HARDENING_FIX_BUGS
        → HARDENING_IDENTIFY ...
        → HARDENING_FIX_BUGS → REVIEWING
        → REVIEWING → FIXING → VERIFYING_FIX → REVIEWING ... → COMPLETED
```

The `HARDENING_*` states implement Phase C (test coverage hardening): identify coverage gaps, write
the missing tests, then fix the bugs those tests expose, looping within configured bounds before
stabilization begins. The last hardening stage transitions into `REVIEWING` only after Phase C's
exit conditions are satisfied.

Include orthogonal `paused`, `blocked`, `failed`, and `reconciliation` states with explicit recovery
transitions:

- **`reconciliation`** is entered when the controller cannot trust the checkout state as-is —
  for example on restart after a crash that occurred between code edits and checkpointing (Section 9), or
  when adopting a dirty checkout (Section 7). It is exited only to `IMPLEMENTING`/the active phase
  after the operator or controller has verified and preserved the inherited changes.
- **`paused`** is entered on a human-decision requirement (Section 10) or on design-document
  invalidation. When an approved design changes after approval (Section 5), the run enters `paused`
  and may only leave via an explicit **re-approval** transition back to `READY`/the active phase once
  the developer approves the new revision and affected steps are reconciled. No implementation,
  hardening, review, or fix state may be entered while the design hash is unreconciled.
- **`blocked`** and **`failed`** preserve evidence and await retry (within budget) or operator action.

Store the previous and next state, triggering operation, evidence, and timestamp for every
transition. Invalid transitions must be rejected.

**The controller, not the LLM, owns the transition rules.**

## 15. Testing requirements

Provide automated unit and integration tests for the controller. Mock Pi and Herdr at the interface
level for deterministic failure scenarios.

At minimum, test:

- A three-step plan completes using three separate fresh Pi sessions.
- The next step cannot begin before the previous one passes verification.
- A failed test prevents step completion.
- A controller crash after code changes but before checkpointing does not duplicate implementation
  work.
- A restarted controller detects an already-running session.
- A lost or ambiguous prompt acknowledgement does not cause blind resubmission.
- An edited design document invalidates the approval until reconciled.
- A blocking review triggers `fix-pr` and then a fresh review.
- A nonblocking review verdict with passing gates completes successfully.
- A *needs discussion* verdict pauses the run.
- A `Blocked`, `Diverging`, or `Exhausted` fix result stops normal progression.
- A stale review result is rejected after the checkout changes.
- The review/fix loop respects configured iteration limits.
- A recurring blocker with unchanged finding identity is detected as no-progress.
- Existing Git changes and nested repository state remain protected.
- Two controller instances cannot run concurrently against the same checkout.
- Missing Pi subagent capabilities cause preflight failure.
- Unexpected agent termination preserves sufficient evidence for recovery.
- No controller path launches concurrent Maven tests in the same QuestDB checkout.
- The coverage-gap, missing-test, and bug-fix hardening stages each run in a fresh Pi session and
  each produce a verified typed handoff artifact before the next stage begins.
- A newly added hardening test that exposes a bug is preserved (not deleted or weakened), and the
  bug is recorded in the bug handoff document.
- A hardening bug fix that remains failing after the fix budget, or returns Blocked/Diverging/
  Exhausted, stops normal progression and preserves evidence.
- A recurring bug with unchanged bug identity across fix attempts is detected as no-progress.
- Phase C must complete before Phase D review/fix stabilization begins.
- Mechanical gating rejects an agent `DONE` claim unsupported by evidence (missing artifact, dirty
  scope, unrun tests).

Use fixture repositories and mocked skill outputs for most tests.

In addition, implement a **real opt-in integration smoke test** using the installed versions of Pi,
Herdr, and the QuestDB skills. It must verify the chosen execution mode supports actual skill
loading, nested subagents, and reliable terminal/structured completion detection. Do not claim
integration compatibility based only on successful unit tests.

## 16. Implementation strategy

Build this incrementally.

### Milestone 0 — Verify integration feasibility (hard gate)

**This milestone is a blocking gate. No work on Milestones 1–3 begins until it passes.** Every later
milestone rests on the assumptions proven here; building on an unproven execution mode risks
discarding the entire implementation.

- Inspect the installed Pi and Herdr APIs, the repository skills, and subagent capabilities.
- Build a small prototype that launches a Pi task, observes its completion using structured evidence,
  and verifies a task artifact.
- Confirm whether RPC/JSON mode can execute the required QuestDB workflows **including nested
  subagents used by `review-pr`/`fix-pr`**. If not, demonstrate a reliable Herdr interactive-session
  alternative that still yields a durable, typed logical-completion record.
- Establish the structured report surface required by Section 8.1 (either a structured-output mode of
  `review-pr` or a documented, tested parsing adapter). Prove verdict and finding boundaries can be
  extracted deterministically; confirm the pause-on-ambiguity path.
- Record the findings and choose **one** primary execution backend. Do not maintain two full
  execution implementations unnecessarily.

Exit criteria: a written feasibility record naming the chosen backend, demonstrating (a) a verified
task artifact from a real Pi session, (b) nested-subagent execution of a QuestDB skill, (c)
deterministic verdict/finding extraction, and (d) a durable typed completion signal that does not
rely on terminal scraping. If any of these cannot be shown, stop and report rather than proceeding.

### Milestone 1 — Durable serial implementation

Implement initialization, plan freezing, session execution, mechanical step verification (Section
6.1), checkpointing, resume, status, and tests. Demonstrate a complete three-step workflow.

### Milestone 2 — Test coverage hardening

Add the Phase C cycle: the coverage-gap identification, missing-test writing, and bug-fix stages,
each in a fresh Pi session with its own typed handoff artifact, mechanical gating, one-writer
enforcement, bounded iteration, and bug-identity no-progress detection. Demonstrate that a test which
exposes an injected bug is preserved and the bug is recorded and fixed.

### Milestone 3 — Stabilization integration

Add the native `review-pr` and `fix-pr` workflow, structured report handling, finding-identity
tracking, and strict acceptance gates.

### Milestone 4 — Reliability

Add crash recovery, interruption handling, no-progress detection, timeouts, audit logs, and full
integration tests.

Do not build a dashboard, distributed scheduler, multi-machine agent pool, or parallel writer system
in the first version.

## 17. Deliverables

Produce:

- A brief architecture document explaining the chosen Pi/Herdr integration.
- The Milestone 0 feasibility record (chosen backend and the evidence behind it). If Milestone 0
  fails its exit criteria, deliver instead a **feasibility-failure report** naming which criterion
  could not be shown and the supporting evidence, per Section 16.
- Working CLI source code and build configuration.
- Automated tests and fixture workflows.
- Installation and setup instructions.
- A sample feature configuration.
- An operator guide explaining initialization, approval, running, monitoring, recovery, and stopping.
- A description of known limitations, especially any unverified Pi/Herdr lifecycle behavior.

The implementation should live outside QuestDB's production source tree, without modifying existing
QuestDB skills. Avoid gratuitous abstractions and generic framework-building.

## 18. Success criteria

Consider the project successful when a developer can:

- Prepare and approve a QuestDB feature design document.
- Initialize the builder against a feature branch.
- Approve the extracted implementation steps.
- Start the builder from a Herdr-managed terminal.
- Leave it running while it implements successive plan steps in fresh Pi sessions.
- Return later to inspect progress and session logs.
- Have the builder automatically harden test coverage after implementation — identifying weak
  spots, writing adversarial/fuzz/concurrency/integration tests, and fixing the bugs they expose —
  before stabilization.
- See the builder automatically use QuestDB's existing review/fix skills after implementation.
- Have the builder stop successfully when the current feature revision passes the configured review
  and test gates.
- Interrupt and resume the workflow without losing verified work or accidentally duplicating it.
- Receive a clear report if the workflow cannot safely continue.

> **Central principle:** The controller executes a human-approved plan through trusted
> repository-specific skills. It must never confuse LLM confidence, terminal idleness, or a
> successful tool invocation with verified engineering completion. The controller gates on mechanical
> evidence it can check itself and delegates semantic judgment to QuestDB's review skill; it never
> self-assesses whether prose acceptance criteria were met.

Start by inspecting the real interfaces and validating the execution mode (Milestone 0), then
implement the smallest working version. Make pragmatic engineering decisions where details are
unspecified, document those decisions, and deliver working code and tests rather than stopping at an
architecture proposal.
