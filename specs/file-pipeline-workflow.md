# Spec: file-based issue pipeline as a dynamic Workflow (`file-pipeline` workflow + `file-pipeline-workflow` skill)

## Purpose

`specs/file-based-workflow.md` established a file-based pipeline (state and the four artifacts on the local filesystem, nothing on the issue thread, a pull request as the only ship channel) and implemented it as the in-session `file-pipeline` skill. That spec's section "Why a skill, not a Workflow script" ruled a Workflow out for one reason: a Workflow's `agent()` calls are non-interactive subagents and the Workflow runtime has no prompt primitive, so a Workflow cannot surface a question and continue in the **same run**; only a session can.

This variant keeps the same file-based storage model but delivers it as a real dynamic Workflow anyway, by relaxing exactly one requirement: **"answer inline and continue in the same run"** becomes **"answer inline and continue in the same session, across a cached Workflow resume."** The Workflow is a pure deterministic engine that stops and returns whenever a human decision is needed; a thin session-context skill owns the human interaction and relaunches the Workflow with the answer. The relaunch resumes from the prior run, so every completed phase replays from cache and no prior work is redone. From the user's seat it is still one continuous ask/answer/continue.

It is additive. The in-session `file-pipeline` skill, the gh-posting `gh-pipeline` workflow, the transition scripts, and every agent stay untouched. This adds a third entry point.

## Why this is possible now, given the earlier "not a Workflow" decision

The earlier decision was correct about the mechanism and only the requirement moved:

- **Still true:** a Workflow cannot ask the user a question mid-run. Its `agent()` calls are subagents; the runtime has no prompt.
- **The relaxation:** the pipeline no longer requires same-*run* continuation. It requires same-*session* continuation, which a thin skill provides by launching the Workflow, reading its stop-and-return, asking the user itself (a skill runs in the session and can call `AskUserQuestion`), and relaunching.
- **Why the relaxation is cheap:** Workflow resume (`resumeFromRunId`) replays every completed `agent()` call from the run journal instantly and runs live only from the first changed/new call onward. Same script + same args → 100% cache hit. So "tear down and relaunch across the answer" does not re-run spec/plan/build already done; it replays them from cache and continues at the answer-consuming call.

The gh-posting `gh-pipeline` workflow already proved the stop-persist-resume loop end-to-end, with GitHub comments as the question channel and a `clarificationAnswer` arg as the answer channel. This spec ports that loop to file-based state: the question channel is `state.json.pendingQuestion`, and the answer channel is a Workflow arg supplied by the skill.

## Goals

- Drive one GitHub issue through spec → plan → build → QA as a dynamic Workflow, with the same three modes on the same two axes as the in-session skill (`auto` / `semi-auto` / `manual`).
- Keep all state and the four artifacts on the local filesystem under `<repo>.issues/<issue>/`, identical to the in-session skill (same `state.json` shape, same transition script, same artifact files).
- Post nothing to the issue thread; produce a pull request as the only ship channel.
- Surface every human decision (a raised clarification, a manual gate, a missing dependency) to the user and continue in the same session, without the Workflow ever guessing.
- Be resumable across a killed session: a question is persisted before it is surfaced, so a re-run re-surfaces it.
- Be drivable headless with no skill at all, by passing answers as args (for `auto` runs, which raise no question, and for automation).

## Non-goals

- Same-*run* question continuation. This variant explicitly does not do it; that is what the in-session `file-pipeline` skill is for. This variant does same-session continuation via cached Workflow resume.
- Replacing the in-session `file-pipeline` skill or the gh-posting `gh-pipeline` workflow. All three coexist.
- Any new state, artifact, or transition semantics. The `state.json` shape, the transition table, the artifact files, and the four agents are reused unchanged.
- A multi-issue launcher. One issue per invocation, as before.

## Architecture: engine + shell

Two pieces, one responsibility each.

### The engine: `workflows/file-pipeline.js` (FR-ENG)

- **FR-ENG-1**: A Workflow script that reads `state.json`, drives the phase whose entry status matches, spawns the four file-writing agents (`dev-crew:spec-writer`, `planner`, `builder`, `reviewer`) with a `schema` forcing their existing `{status:"done"}` / `{status:"clarification-needed",...}` return, verifies each artifact on disk, and advances the state only through the validated transition script.
- **FR-ENG-2**: Bookkeeping calls (git-root resolution, `state.json` read/patch, the transition script, the linked-PR lookup, the QA-verdict read, artifact-existence checks, dependency-path resolution) run on Haiku with a `schema`, so a chatty or empty plain-text result cannot be mistaken for real content and stall the loop, exactly as the gh-posting workflow does.
- **FR-ENG-3**: `status` is written **only** by the transition script (`issue-state-transition.sh`). A dedicated `patchState` helper writes the non-gated fields (`mode`, `prNumber`, `qaVerdict`, `pendingQuestion`, `dependsOn`) and throws if asked to write `status`. A non-zero transition exit is a hard error, never forced through.
- **FR-ENG-4**: The engine **never asks a question**. On any human decision it persists the question to `state.json.pendingQuestion` **first**, then **returns** a typed object:
  - `{status:"question", pendingQuestion:{phase,kind:"clarification",question,options,recommendedDefault}}`
  - `{status:"gate", gate, pendingQuestion:{...,kind:"gate"}}`
  - `{status:"dependency", missing, pendingQuestion:{...,kind:"dependency"}}`
  and terminal returns `{status:"done"|"rejected"|"merged"|"waiting", ...}`.
- **FR-ENG-5**: The engine resumes from args. It accepts `{issueNumber, mode?, answer?, directive?}` (and the same object JSON-stringified, and bare `"N"` / `"N mode"` tokens). On a relaunch that carries an `answer`/`directive`, it consumes the persisted `pendingQuestion`, clears it, and routes the response as if it had just been raised (re-run the phase agent with the answer folded in; or take the gate's approve/revise branch; or the dependency's proceed/wait branch). A relaunch with a still-pending question but no response re-returns the same waiting object rather than guessing.
- **FR-ENG-6**: `auto` mode raises no question by construction (each agent is told to adopt its own recommended default and record it in the artifact), so the engine runs straight through to a terminal return with no relaunch and no skill.

### The shell: `skills/file-pipeline-workflow/SKILL.md` (FR-SHELL)

- **FR-SHELL-1**: A skill that runs in the session's own context. Its sole job is to launch the engine, read the returned object, and, on a `question`/`gate`/`dependency` status, build an `AskUserQuestion` directly from the returned `pendingQuestion` (recommended option first), take the answer, and relaunch the engine with the answer mapped to `args.answer` (clarification) or `args.directive` (gate: `approve`/`revise`; dependency: `proceed`/`wait`).
- **FR-SHELL-2**: Relaunch uses `resumeFromRunId` from the prior run, so completed phases replay from cache and only the answer-consuming call onward runs live.
- **FR-SHELL-3**: The shell loops (launch → read → ask → relaunch) until the engine returns a terminal status, then reports the outcome. It does no pipeline work itself: it never reads or writes `state.json`, never runs the transition script, never invokes a phase agent, never touches an artifact.
- **FR-SHELL-4**: On an unanswered question (timeout, empty, declined), the shell **stops and does not relaunch with a guess**. The engine already left `pendingQuestion` set and the status unchanged, so a later re-run relaunches the engine, which re-returns the same waiting object, and the shell re-asks. This mirrors the in-session skill's "stop, don't guess" rule and the same background-session AskUserQuestion constraints motivate it.
- **FR-SHELL-5**: The shell never prints decision context as prose before `AskUserQuestion`; everything the user needs is inside the returned `question` and option text (the engine already put it there).

## Storage and reuse (FR-REUSE)

- **FR-REUSE-1**: `state.json` shape is identical to the in-session skill's (`status`, `mode`, `prNumber`, `qaVerdict`, `pendingQuestion`, `dependsOn`), with the same bare-status vocabulary and the same four `*-awaiting-approval` gate states.
- **FR-REUSE-2**: The state root and per-issue folder are derived from git identically (`<parent>/<repo>.issues/<issue>/`, one root across all worktrees).
- **FR-REUSE-3**: The transition script is `issue-state-transition.sh` unchanged. The engine shells out to it for every status move.
- **FR-REUSE-4**: The four file-writing agents are reused unchanged. Their existing structured return is exactly what the engine's `agent(..., {schema})` call needs; no agent edit is required.
- **FR-REUSE-5**: Because the storage is identical, the same issue could in principle be driven by either the in-session skill or this workflow (not both interleaved). They share one `state.json`.

## Modes (FR-MODE)

Same two orthogonal axes as the in-session skill:

- **Questions axis**: `auto` never surfaces (agent adopts its default). `semi-auto`/`manual` surface a raised clarification as a `question` return the shell asks.
- **Artifact-approval axis**: `auto`/`semi-auto` auto-advance. `manual` returns a `gate` after every phase; the shell asks approve/revise. `approve` transitions to the phase's real next status; `revise` re-runs the phase agent (spec/plan editorially, on the cheaper model; build with real code changes) and re-gates. The QA-gate `revise` routes feedback plus `qa.md` to the build agent, re-runs QA, and re-gates.

## QA rejection loop (FR-QA)

- In `auto`/`semi-auto`, a `rejected` verdict loops back to build (transition to `in-progress`, fixup from `qa.md`, back to `ai-review`, re-run QA), up to `MAX_QA_ROUNDS` total build attempts, then leaves the issue at `in-progress` and returns `{status:"rejected"}`. This post-verdict handling is shared by the phase loop and the resume-of-a-QA-clarification path, so a QA clarification answered mid-QA drives the same rejection loop and final transition rather than re-running QA from scratch.

## Dependencies (FR-DEP)

- `dependsOn` is read-only and one-directional, set explicitly, identical to the in-session skill. The engine passes existing depended-on `spec.md`/`plan.md` as read-only context and passes no other-issue path when empty.
- A missing depended-on artifact returns `{status:"dependency"}`. The shell asks proceed/wait. `wait` returns `{status:"waiting"}`. `proceed` relaunches with `directive:{kind:"proceed"}`; the engine then runs that phase with whatever artifacts exist and, for this one invocation, does not re-stop on the still-missing ones (the proceed decision is remembered within the run, not persisted).

## Merge (FR-MERGE)

- `mode:"merge"` is a standalone terminal action: the engine refuses unless `state.json.status` is `human-review`, then squash-merges the linked PR, deletes the branch, transitions to `closed`, and returns `{status:"merged"}`. Never invoked automatically. The shell needs no relaunch for merge.

## Install (FR-INSTALL)

- The engine is a Workflow script and Workflow scripts are not plugin-discoverable, so `workflows/file-pipeline.js` is copied per target repo (like `gh-pipeline.js`), alongside the already-required `issue-state-transition.sh`.
- The shell is a skill and skills are plugin-discoverable, so `skills/file-pipeline-workflow/` ships with the plugin and needs no per-repo copy (like the in-session `file-pipeline` skill).
- Net: one plugin install (agents + both skills) plus a two-file copy per target repo (the workflow script and the transition script).

## Acceptance criteria

1. `file-pipeline.js` with `mode:"auto"` on a fresh issue produces `spec.md`, `plan.md`, a linked PR, `build.md`, `qa.md` under `<repo>.issues/<issue>/`, advances `state.json.status` through the full sequence via the transition script, raises no question, returns `{status:"done"}`, and posts nothing to the issue thread.
2. In `semi-auto`/`manual`, an agent's raised clarification makes the engine persist `pendingQuestion` and return `{status:"question"}` without guessing; the shell asks it via `AskUserQuestion` and relaunches with `args.answer`, resuming from cache.
3. `manual` returns `{status:"gate"}` after each phase; the shell's `approve` advances and `revise` re-runs the phase; a QA-gate `revise` routes to the build agent.
4. A killed session with `pendingQuestion` set loses nothing: a re-run relaunches the engine, which re-returns the same waiting object, and the shell re-asks.
5. A missing dependency returns `{status:"dependency"}`; `proceed` continues without re-stopping on the same missing dependency within the run; `wait` returns `{status:"waiting"}`.
6. `mode:"merge"` refuses unless `status` is `human-review`, then merges and returns `{status:"merged"}`.
7. The engine writes `status` only through `issue-state-transition.sh`; `patchState` refuses to write `status`.
8. No file, directory, agent-type prefix, workflow name, or user-facing string in the new engine or shell contains "openducktor" or "odt"; the plugin is `dev-crew` and the agent prefix is `dev-crew:`.

## Open questions

None. The one material decision, relaxing same-run to same-session continuation via cached Workflow resume, is settled and is the premise of this variant.
