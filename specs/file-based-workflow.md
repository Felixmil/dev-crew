# Spec: file-based issue pipeline (`/issue-pipeline` skill)

## Purpose

The existing `openducktor-issue` workflow drives one GitHub issue through spec → plan → build → QA, and it uses GitHub issue and pull request threads for three jobs at once: as the artifact store (spec/plan issue comments, the PR body, the QA PR comment), as the human-interaction channel (`/approve` and `/revise` comments), and, via `[NEEDS CLARIFICATION]` markers scanned out of those comment bodies, as the clarification gate. Only the state machine lives elsewhere, on the issue's `status:*` labels.

Against a **public** repository that pollutes the issue and PR threads with artifacts and control chatter specific to *this* personal workflow, not to the repository's own conventions. This variant, `/issue-pipeline`, keeps the two things genuinely shared with the repository, the **GitHub issue as input** and the **pull request as the mechanism that ships code**, and moves everything else (state, the four artifacts, human approval, and clarification) onto the local filesystem and into the running session, outside the public repository's threads and tree.

It is a sibling to the existing pieces, not a replacement. The four existing gh-posting agents and `openducktor-issue.js` stay untouched.

## Why a skill, not a Workflow script

The original is a Workflow script (`openducktor-issue.js`). This variant is deliberately **not**, for one hard reason established during design:

- A Workflow script's `agent()` calls spawn **subagents**, and subagents cannot call `AskUserQuestion`; they are strictly non-interactive (confirmed against Claude Code's docs and issue tracker). A Workflow script itself has no prompt primitive either. So a Workflow script **cannot** surface a question and wait for an answer without returning control, i.e. exiting the run.
- The core requirement here is the opposite: **when an agent raises a question mid-pipeline, the human answers it inline and the pipeline continues in the same run**, never tearing down the run to answer a question.
- Only a **full Claude Code session** can call `AskUserQuestion`, pause, and resume. A **skill / slash-command runs in the session's own main context**, so it can prompt inline and can touch the filesystem directly. A **background session is a full Claude Code conversation** (per the agent-view docs), so a skill dispatched as a background session can pause on a question, surface it in agent view, accept an inline answer, and resume, exactly the target behaviour.

Therefore `/issue-pipeline` is a skill that runs the phase loop in its session, spawns worker subagents for the heavy per-phase reasoning, and prompts the human inline via `AskUserQuestion` when needed.

## How the fleet works (one issue per session)

There is **no** multi-issue launcher. The skill always drives **exactly one issue**. The "fleet" is simply several independent background sessions the human dispatched separately, one per issue, watched together in agent view:

- The human dispatches `/issue-pipeline 142 semi-auto` as one background session, `/issue-pipeline 143 semi-auto` as another, and so on (via `claude --bg`, `/bg`, or the agent-view dispatch input). Each is its own full session.
- Agent view groups them; a session that raises a question shows "Needs input". The human peeks (`Space`), answers inline (picking a numbered option for a multiple-choice question), and that session resumes. The others are unaffected.
- The skill contains **no** cross-issue orchestration, no batching, no fan-out over issues. It concerns itself with one issue end to end; agent view does the fleet-watching.

## Goals

- Drive one GitHub issue through spec → plan → build → QA, in three modes (auto / semi-auto / manual) defined on two independent axes (below).
- Read the issue as **input** from GitHub exactly as today.
- Produce a **pull request** as the shipping artifact: a real PR against the repository with a clean, repository-facing body.
- Keep the four artifacts (spec, plan, build summary, QA report) as **local files**, never posted to the issue or PR thread.
- Keep the **state machine** as a **local file** (`state.json`), never as `status:*` labels on the public issue.
- Answer any question an agent raises **inline in the running session** via `AskUserQuestion`, without exiting the run.
- Be **resumable**: a run stopped while a question was unanswered must re-ask that question on the next run.
- Keep each issue's files **isolated** from other issues' contexts, except where an explicit dependency grants read access.
- Leave the public repository's issue and PR threads untouched by anything that is purely this workflow's bookkeeping.

## Non-goals

- Replacing `openducktor-issue.js`, `odt-transition.sh`, or the four gh-posting agents. All coexist.
- A multi-issue launcher or any cross-issue orchestration inside the skill (agent view provides the fleet layer).
- A `decision.txt` / file-based directive channel. Interactivity is inline; see "Resumability" for how a stopped run recovers instead.
- Worktree isolation between build and QA, a canonical task-summary object (same known gaps as the original).
- Any change to `refine-issue`. It already edits the issue body in place (a refined issue *is* shared repository input) and raises no pipeline gate; out of scope.
- A fallback answer channel for the known agent-view "stuck on AskUserQuestion" bug (see Risks). Inline-only for now; revisit if it bites.

## The three jobs GitHub comments do today, and where each moves

| Job | Today (GitHub) | This variant |
| --- | --- | --- |
| Artifact store | spec/plan issue comments; PR body; QA PR comment | one `.md` file per artifact in a per-issue folder |
| State machine | `status:*` labels on the issue | `state.json` in the per-issue folder |
| Human I/O + clarification | `/approve` / `/revise` comments; marker scanned from comment bodies | inline `AskUserQuestion` in the running session (question raised before the artifact is written, so nothing to scan) |

What stays on GitHub: reading the issue (input) and creating/updating the pull request (ship). The PR body is a clean, repository-facing description. The workflow's own control chatter and per-round bookkeeping never appear on GitHub.

## Modes: two independent axes (FR-MODE)

The mode controls two separate behaviours: whether the pipeline **surfaces questions** to the human, and whether it **gates on artifact approval**.

| Mode | Questions (ambiguity an agent raises) | Artifact approval |
| --- | --- | --- |
| **auto** | Never surfaced. The agent makes its best-judgment decision and records it. | Auto-approve every artifact; run straight through. |
| **semi-auto** | Asked inline via `AskUserQuestion` when genuinely needed. | Auto-approve every artifact. |
| **manual** | Asked inline when genuinely needed. | Stop after each artifact; the human approves or requests revision inline. |

- **FR-MODE-1**: "Question" and "artifact approval" are distinct events. A question is a genuine, materially scope-changing ambiguity an agent cannot resolve from repo evidence (the same bar as today's `[NEEDS CLARIFICATION]`). An artifact-approval gate is the human signing off on a completed spec/plan/build/QA artifact.
- **FR-MODE-2**: In **auto**, an agent that would otherwise raise a question instead adopts its own recommended default, records the decision in the artifact, and continues. Nothing is surfaced.
- **FR-MODE-3**: In **semi-auto** and **manual**, a raised question is surfaced inline via `AskUserQuestion` (a multiple-choice question with a recommended default first, matching the user's numbered-option preference), the session pauses, and on answer the pipeline folds the answer in and continues in the same run.
- **FR-MODE-4**: Only **manual** gates artifacts. After each phase's artifact is written, the human is asked inline to approve or revise; `revise` re-runs that phase and re-writes the artifact in place, then asks again; `approve` advances. Auto and semi-auto never gate artifacts.
- **FR-MODE-5**: The skill invocation is `/issue-pipeline <issue> [mode]`, mode defaulting to **`semi-auto`**. A bare invocation therefore surfaces a genuine ambiguity inline rather than silently guessing, but still auto-approves artifacts; `auto` (fully silent) and `manual` (gate each artifact) are opt-in. It also accepts a merge action, `/issue-pipeline <issue> merge`, as a standalone terminal action (FR-SHIP-4).

## Where local state lives (FR-LOC)

- **FR-LOC-1**: State lives under a **root directory outside the repository tree**, a sibling of the checkout named `<repo>.issues/`. For `~/Code/esqlabsR`, the root is `~/Code/esqlabsR.issues/`. Matches the worktree-sibling convention, never pollutes the repo, needs no `.gitignore`, and survives branch/worktree changes because it is outside every worktree.
- **FR-LOC-2**: The root is derived, not configured: the main-checkout name is the basename of the parent of git's common dir (`git rev-parse --git-common-dir` returns `.../<repo>/.git`, whose parent's basename is `<repo>`), so all worktrees of the same repository share one state root; outside a worktree this equals the current toplevel's basename.
- **FR-LOC-3**: Each issue has its own folder named by issue number: `<repo>.issues/142/`. All state and artifacts for issue 142 live there and nowhere else.
- **FR-LOC-4**: The folder is created on first use and idempotent to re-create. A re-run reads and updates it in place; it never wipes prior artifacts except by the in-place revision rules below.
- **FR-LOC-5**: Because the skill runs in the session's main context, it reads and writes these files **directly** (the session has filesystem access); no subagent-brokering of filesystem I/O is needed. Worker subagents are handed concrete paths when they need to read or write an artifact.

## Per-issue folder contents (FR-FILE)

- **FR-FILE-1**: `state.json` is the single source of truth for the issue's pipeline state. It holds at minimum:
  - `status`: the current status, using the same vocabulary as the transition table (`open`, `spec-ready`, `ready-for-dev`, `in-progress`, `blocked`, `ai-review`, `human-review`, `closed`, plus the four `*-awaiting-approval` gate states used by manual mode).
  - `mode`: the mode this issue is being driven in.
  - `prNumber`: the linked pull request number once known.
  - `qaVerdict`: the last QA verdict.
  - `pendingQuestion`: `null`, or an object describing a question raised but not yet answered (see FR-RESUME).
  - `dependsOn`: an array of issue numbers this issue depends on (see FR-ISO), default `[]`.
- **FR-FILE-2**: Each artifact is its own markdown file: `spec.md`, `plan.md`, `build.md`, `qa.md`. A file that does not yet exist means that phase has not produced its artifact.
- **FR-FILE-3**: There is **no** `decision.txt` and no file-based directive channel. Human approve/revise/answer happens inline via `AskUserQuestion`.
- **FR-FILE-4**: The state root and per-issue folders are the workflow's private working area. Nothing in them is ever `git add`ed, committed, or pushed, and nothing is ever posted to a GitHub issue or PR thread. (They sit outside the tree per FR-LOC-1, so this holds by construction; stated so a future change cannot silently violate it.)

## Resumability: a stopped-but-unanswered question re-asks (FR-RESUME)

- **FR-RESUME-1**: Before the skill prompts the human with a question, it **first records that question in `state.json.pendingQuestion`** (phase, question text, the options, and the recommended default). Only then does it call `AskUserQuestion`.
- **FR-RESUME-2**: On the answer, the skill **clears `pendingQuestion` to `null`** and folds the answer into the phase agent's instructions, then re-invokes that agent so it can proceed (and eventually write its artifact). Because questions are resolved before any artifact is written (FR-ART-2), the answer flows into the agent, not into an existing file.
- **FR-RESUME-3**: If the session is stopped (killed, machine sleep past recovery, closed) after `pendingQuestion` was set but before it was cleared, a later `/issue-pipeline <issue>` run detects the non-null `pendingQuestion` **before doing anything else** and re-asks that exact question via `AskUserQuestion`, then proceeds as if it had just been raised. Since no artifact was written yet, `pendingQuestion` in `state.json` is the sole record of the open question; a question is therefore never silently lost by a stopped run.
- **FR-RESUME-4**: More generally, every run derives "where am I" from `state.json` (status + pendingQuestion), never from session memory, so re-running an issue always resumes from its persisted state.

## Context isolation and cross-issue dependencies (FR-ISO)

- **FR-ISO-1**: By default, one issue's per-issue folder is **isolated**: the agents driving issue 142 read only `142/`'s files (plus GitHub issue 142 and the repo). They are not given the paths to any other issue's folder, so one issue's spec/plan/build/QA cannot contaminate another issue's context.
- **FR-ISO-2**: An issue declares dependencies in its own `state.json.dependsOn`, an array of issue numbers. When it is non-empty, the agents driving that issue **are** given read access to the depended-on issues' artifact files (e.g. `143/spec.md`, `143/plan.md`), so a dependent issue can be planned and built with knowledge of what it depends on.
- **FR-ISO-3**: Dependency access is **read-only and one-directional**: issue 142 depending on 143 lets 142's agents read 143's artifacts; it does not let 143 read 142's, and does not let 142 write into `143/`.
- **FR-ISO-4**: `dependsOn` is set **explicitly only** (by the human when dispatching, or written into `state.json`). The skill does not read GitHub issue references to auto-populate it; GitHub-derived dependencies are a possible later enhancement, deliberately out of scope for v1, since explicit declaration is unambiguous and deriving dependencies reliably from issue text is its own problem.
- **FR-ISO-5**: If `dependsOn` names an issue whose folder or artifacts do not exist yet at the point they would be read, the skill does not silently proceed and does not hard-block. It surfaces the situation inline via `AskUserQuestion` (proceed without the missing dependency, or wait), letting the human decide per case, consistent with the resumability model (the decision, if it becomes a pending question, is persisted like any other, FR-RESUME).

## State machine (FR-STATE)

- **FR-STATE-1**: The transition table is exactly the one `odt-transition.sh` enforces today (which mirrors OpenDucktor's `status-transition-policy.ts`): the same states, allowed edges, `type:task`/`type:bug` skip-spec shortcut, and the four manual-mode `*-awaiting-approval` gate states entered-from and exited-to the same states. Only the storage changes (a `state.json` field instead of a GitHub label). A comment at the table cites the OpenDucktor lineage; that is the only place the OpenDucktor name survives.
- **FR-STATE-2**: Transitions are validated against the table before `state.json.status` is written. An illegal transition fails loudly and does not mutate the file. The status-writing step is the single mutator of status.
- **FR-STATE-3**: Bootstrapping: an issue with no `state.json` yet is treated as `open`, and the folder plus an `open` `state.json` are seeded on first sight.
- **FR-STATE-4**: No `status:*` labels are written to the GitHub issue; the target repo does **not** need those labels created. The `type:task`/`type:bug` skip-spec shortcut still **reads** the issue's type labels from GitHub (read-only input) but writes nothing back.

## Artifacts and agents (FR-ART)

- **FR-ART-1**: The skill uses **four new file-writing agents** for the heavy per-phase reasoning, forked from the four existing gh-posting agents (which stay untouched). Names describe function and contain no "openducktor"/"odt". They inherit the session model.
- **FR-ART-2**: Spec and plan agents read the issue (input) and the repo, and write their artifact to the per-issue folder path they are handed (`spec.md` / `plan.md`); they do not post gh comments for the artifact. **Questions are raised and resolved before the artifact is written, not after.** An agent that hits a genuine ambiguity does not write a half-finished artifact with an open marker in it; instead it stops and returns a structured "clarification needed" result (see FR-ART-6). Only once every raised question is answered does the agent write a final, clean artifact with the answers folded in. No `[NEEDS CLARIFICATION]` marker is ever left in a written artifact.
- **FR-ART-3**: The build agent implements the plan, opens or updates the **real pull request** with a clean, repository-facing body (`Closes #N`), and separately writes the fuller workflow build summary to `build.md`. It does not post the build summary as a PR comment. On later rounds (QA fixup, manual-gate revise) it pushes code to the PR branch and updates `build.md`, posting no per-round PR narration comment.
- **FR-ART-4**: The QA agent reviews the PR diff against the local `spec.md` / `plan.md`, and writes the QA report to `qa.md` ending in exactly one `QA-VERDICT: approved|rejected` line. It does not post a QA PR comment.
- **FR-ART-5**: The skill **reads each artifact back** after the agent has written it (to parse the QA verdict, to confirm the artifact was actually produced) rather than trusting the agent's own summary of what it wrote.
- **FR-ART-6**: How a raised question reaches the human: because agents cannot prompt (only the session can) and because **artifacts are written only after all questions are answered** (FR-ART-2), the agent, on hitting a genuine ambiguity, **returns without writing its artifact**, via a structured "clarification needed" result carrying the question text, the options, and the recommended default. The skill records that in `pendingQuestion` (FR-RESUME-1), calls `AskUserQuestion` inline, then re-invokes the same agent with the answer folded into its instructions. The agent may raise more than one question across such round-trips; each is answered before it proceeds. Only when the agent returns with no further question does it write the final artifact. There is no `[NEEDS CLARIFICATION]` marker scanned out of a file for questions; the structured return is the sole question channel, and `pendingQuestion` in `state.json` is the sole persisted record (there is no half-written artifact to recover from).

## Clarification (FR-CLAR)

- **FR-CLAR-1**: A question is a genuine, materially scope-changing ambiguity an agent cannot resolve from repo evidence, surfaced **before** its artifact is written (FR-ART-2, FR-ART-6). It is never encoded as a marker inside a written artifact.
- **FR-CLAR-2**: Mode governs whether a raised question is surfaced:
  - In **auto**: questions are never surfaced. The agent adopts its own recommended default, records the decision inside the artifact it writes, and continues. Auto never blocks.
  - In **semi-auto** and **manual**: the skill records the question in `pendingQuestion`, surfaces it inline via `AskUserQuestion`, folds the answer back into the agent's instructions, and lets the agent proceed (and write its now-final artifact) once no question remains (FR-RESUME).
- **FR-CLAR-3**: This is separate from manual mode's **artifact-approval** gate. A spec produced with no question in semi-auto still auto-approves and moves on; the same spec in manual still stops for approve/revise even when no question was ever raised.

## Shipping: the pull request stays on GitHub (FR-SHIP)

- **FR-SHIP-1**: The build phase opens or updates a **real pull request** referencing the issue (`Closes #N`). The linked-PR lookup logic (`findLinkedPr` in the original) is reused.
- **FR-SHIP-2**: The PR **body** is a clean, repository-facing description written for that repository's reviewers. The workflow's own fuller build summary (deviations, verification, per-round notes) lives in `build.md`. The two are deliberately different: the public PR body stays clean, the local `build.md` carries the workflow's record.
- **FR-SHIP-3**: QA-rejection fixups and manual-gate build revisions do **not** post PR bookkeeping comments. The build agent pushes code to the PR branch (the diff is the public artifact) and updates `build.md` locally.
- **FR-SHIP-4**: **merge mode** is a standalone terminal action: it refuses unless `state.json.status` is `human-review`, then squash-merges the linked PR, deletes the branch, and sets `status` to `closed`. Never invoked automatically by auto/manual/semi-auto.

## Edge cases

- A run stopped while a question was pending: the next run re-asks it (FR-RESUME-3).
- An issue folder deleted between runs: treated as a fresh `open` issue (FR-STATE-3); prior artifacts are gone by the user's choice.
- An agent that keeps raising questions: each is answered inline before it proceeds; it writes its artifact only once none remain (FR-ART-6).
- No linked PR at a phase that needs one (QA, merge): fail with a clear message.
- Manual-mode QA-gate revise: routes feedback plus the current `qa.md` to the **build** agent (not QA), re-runs QA, re-writes `qa.md`, stays at the gate.
- An issue in `dependsOn` that has no folder or artifacts yet: the skill surfaces it inline via `AskUserQuestion` (proceed without it, or wait); it neither silently proceeds nor hard-blocks (FR-ISO-5).

## Constraints

- Reuse the transition table verbatim (FR-STATE-1); cite the OpenDucktor lineage in a comment at the table, the only surviving use of that name.
- The status-writing step is the sole mutator of `status` and validates every transition (FR-STATE-2).
- `pendingQuestion` is written before prompting and cleared after answering (FR-RESUME), so resumability is structural, not best-effort.
- Per-issue isolation is the default; cross-issue reads happen only through `dependsOn` (FR-ISO).
- The four file-writing agents inherit the session model, as the originals do.
- No new name references OpenDucktor / `odt`; that name survives only in lineage comments.

## Acceptance criteria

1. `/issue-pipeline <issue> auto` on a fresh issue produces `spec.md`, `plan.md`, a real linked PR, `build.md`, `qa.md` under `~/Code/<repo>.issues/<issue>/`, advances `state.json.status` through the full sequence, surfaces no questions, and posts nothing to the issue thread and no bookkeeping comment to the PR.
2. The GitHub issue thread has zero comments added by the workflow; the only GitHub writes are the PR and its `Closes #N`. The PR body reads as a clean repo-facing description; `build.md` (local) is the fuller summary and differs from it.
3. `semi-auto`: when an agent raises a genuine ambiguity, the session pauses on an inline `AskUserQuestion`; answering it (from agent view or the session) resumes the same run; artifacts are otherwise auto-approved.
4. `manual`: each phase stops for inline approve/revise after writing its artifact; `revise` re-runs the phase and re-writes the artifact in place; `approve` advances. Questions are also surfaced inline as in semi-auto.
5. Resumability: with `state.json.pendingQuestion` set (question raised) and the session stopped before answering, re-running `/issue-pipeline <issue>` re-asks that exact question before doing anything else, and clears it once answered.
6. Isolation: an issue with `dependsOn: []` gives its agents no access to any other issue's folder; an issue with `dependsOn: [143]` lets its agents read `143/`'s artifacts (read-only) and nothing else.
7. Multiple issues dispatched as separate background sessions appear as separate rows in agent view; a question in one shows "Needs input" and is answerable inline without affecting the others; there is no multi-issue launcher in the skill.
8. `merge` refuses unless `state.json.status` is `human-review`, then squash-merges the linked PR and sets `status` to `closed`.
9. The target repo needs no `status:*` labels created; only `gh` auth and (optionally) `type:*` labels for the skip-spec shortcut.
10. No new file, directory, agent name, or user-facing string contains "openducktor" or "odt"; those appear only in lineage comments.
11. A bare `/issue-pipeline <issue>` (no mode word) runs in **semi-auto**: it surfaces a genuine ambiguity inline but auto-approves artifacts.
12. A question is always raised **before** its artifact is written; no written artifact ever contains an open `[NEEDS CLARIFICATION]` marker, and a run stopped mid-question leaves no partial artifact, only `state.json.pendingQuestion`.

## Open questions

None. All material decisions are settled:
- Default mode for a bare invocation: **semi-auto** (FR-MODE-5).
- `dependsOn`: **explicit only** for v1, no GitHub auto-derivation (FR-ISO-4).
- Agent→skill question signalling: **structured return only**, since artifacts are written only after all questions are answered, so there is no in-file marker to scan (FR-ART-6, FR-ART-2).
- Missing depended-on issue: **ask inline** whether to proceed or wait (FR-ISO-5).
