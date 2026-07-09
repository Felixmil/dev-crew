---
name: run-pipeline
description: Drives one issue (a GitHub issue number, or a local L-prefixed issue) through spec -> plan -> build -> QA, keeping the artifacts and state machine on the local filesystem under <repo>.issues/<issue>/ and every human question inline. Use when the user says "run the pipeline on N", "drive issue N through the pipeline", passes a mode (auto/semi-auto/manual), or invokes /run-pipeline with an issue number.
---

# Issue pipeline (file-based)

You drive one issue through spec -> plan -> build -> QA. You run in this session's own context, so you own every `AskUserQuestion` and every file read/write directly; you spawn the four file-writing subagents for the heavy per-phase reasoning and hand each one concrete filesystem paths. The four artifacts (`spec.md`, `plan.md`, `build.md`, `qa.md`), the state (`state.json`), and every human question live on the local filesystem and in this session. The GitHub issue is only the input; a pull request is only the ship channel. You never post a comment to the issue thread, and you never add a bookkeeping comment to the pull request.

This skill shares its machinery with the other pipelines through reference files under `${CLAUDE_PLUGIN_ROOT}/references/pipeline/`. Read each one at the point the sections below send you to it, and follow it exactly; this `SKILL.md` carries only what is specific to the file-based pipeline.

## Mission

Take the issue from wherever `state.json` says it is to the next resting point, writing each phase's artifact to disk, advancing the state only through the transition script, and surfacing every question inline in a way that survives the session being killed. Where you are is always read from `state.json`, never from what you remember of this conversation.

## Setup

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/state-and-setup.md` for the argument parse, folder bootstrap, mode reconcile, and job rename. This pipeline fills its two deltas as follows:

- **State root**: `<parent>/<repo>.issues`, derived from git. Run `git rev-parse --show-toplevel` for the working-tree root; its basename is `<repo>`, its parent is `<parent>`. Example: a repo at `~/Code/esqlabsR` gives a state root of `~/Code/esqlabsR.issues`.
- **Seed object**: the standard fields (`status: open`, `mode`, `branch`, `prNumber`, `qaVerdict`, `pendingQuestion`, `dependsOn`), no extras.
- **Archive check (before bootstrap).** A merged issue's folder is moved to `<root>/archive/<issue>/` by `/merge-pr`. If `<root>/archive/<issue>/` exists, the issue is closed and shipped: do not re-bootstrap an empty active folder; tell the user it is already merged and archived and stop (unless they explicitly want to re-open it, in which case they move it back out of `archive/` themselves).

**Local issues.** An id starting with `L` (e.g. `L3`) is a **local issue**: it has no GitHub issue, its description lives in `<root>/<id>/issue.md` (created by the create-local-issue skill), and it is driven exactly like a GitHub issue except: (a) wherever you would read the issue with `gh issue view`, read `<root>/<id>/issue.md` instead; (b) the transition script already treats a local id as non-task and does no `gh` call; (c) the build phase opens a PR that references the local id in text rather than `Closes #N`, and the linked PR is found by branch (see the finding-pr reference). Everything else is identical.

## Resume and raising questions

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/raising-questions.md` exactly: on load, re-ask any persisted `pendingQuestion` before touching a phase; whenever a question must be surfaced, persist it to `state.json.pendingQuestion` first, then ask, and stop cleanly (never guess a default) if no answer comes back.

## The phase loop

Read `state.json.status` and drive the phase whose entry status matches. The phases and their transition edges (all applied only through the transition script):

| Phase | Entry status | Agent | On success -> |
| --- | --- | --- | --- |
| spec  | `open` | `dev-crew:spec-writer` | `spec-ready` |
| plan  | `spec-ready` | `dev-crew:planner` | `ready-for-dev` |
| build | `ready-for-dev`, `in-progress`, `blocked` | `dev-crew:builder` | first `in-progress`, then `ai-review` |
| qa    | `ai-review` | `dev-crew:reviewer` | `human-review` (approved) or `in-progress` (rejected) |

Every issue runs the full spec -> plan -> build -> QA path; there is no skip-spec shortcut (the transition script has no `open -> in-progress` edge).

For each phase, in order:

1. **Compute the artifact path(s)** as absolute paths: `<root>/<issue>/spec.md`, `.../plan.md`, `.../build.md`, `.../qa.md`.
2. **Resolve dependency read-paths** per `${CLAUDE_PLUGIN_ROOT}/references/pipeline/depends-on.md`. This pipeline resolves a dependency's `spec.md` and `plan.md`, with the `<root>/archive/D/` fallback.
3. **Invoke the phase agent** with a `schema` forcing the structured return object. In the prompt, hand it: the issue number, the exact absolute path to write its artifact to, the read-only paths (this issue's upstream artifacts and any dependency artifacts), and, in `auto` mode, the instruction to adopt its own recommended default on any ambiguity and record the decision in the artifact (so it returns `done`, never `clarification-needed`).
4. **On a `clarification-needed` return** (only in `semi-auto`/`manual`): follow the raising-questions reference, then re-invoke this same phase agent with the answer folded in. The agent writes the artifact only after the answer is in hand.
5. **On a `done` return**: read the artifact back from disk to confirm it exists and is non-empty (never trust the agent's summary that it wrote the file). For QA, parse the trailing line matching `QA-VERDICT:` from `qa.md` itself (an HTML comment, `<!-- QA-VERDICT: approved -->` / `<!-- QA-VERDICT: rejected -->`; read the verdict word out of the last such line) and record it in `state.json.qaVerdict`.
6. **Artifact-approval gate** per `${CLAUDE_PLUGIN_ROOT}/references/pipeline/modes.md`: in `manual` mode, stop for an approve/revise decision before advancing; in `auto`/`semi-auto`, advance immediately.
7. **Advance the status** by shelling out to the transition script (see the state-and-setup reference), then re-read `state.json.status` and continue.

### Build phase specifics

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/build-phase.md` for the dedicated branch, isolated worktree, entry transition, and PR-number caching. This pipeline's delta: the builder **owns the PR body**, opening/updating the PR with a clean `Closes #<issue>` body (a local-id reference line, no `Closes`, for a local issue).

### QA phase specifics

- Read the verdict from the last `QA-VERDICT:` line in `qa.md` (the HTML comment), not from the agent's return.
- In `auto`/`semi-auto`: on `rejected`, route `qa.md` plus the rejection back to the **build** agent as fixup feedback, transition `ai-review -> in-progress`, re-run build, transition back to `ai-review`, re-run QA. Repeat up to 3 total build attempts; if still rejected, leave the issue at `in-progress` for a human and stop. On `approved`, transition `ai-review -> human-review`.
- In `manual`: after writing `qa.md`, hit the QA approval gate (modes reference).
- **Flip the PR out of draft on the way into `human-review`.** The builder opens the PR as a draft and it stays draft through every rework round; the moment the issue reaches `human-review` (QA approved), mark the PR ready with `gh pr ready <pr>` (re-derive `<pr>` fresh). Do this in every mode when the transition into `human-review` happens. It is idempotent; a failure here is a soft warning, not a pipeline failure.

## The status list

Statuses are bare (no `status:` prefix): `open`, `spec-ready`, `ready-for-dev`, `in-progress`, `blocked`, `ai-review`, `human-review`, `closed`, and the four manual-mode gates `spec-awaiting-approval`, `plan-awaiting-approval`, `build-awaiting-approval`, `qa-awaiting-approval`. The transition script's edge table is the single source of truth for which edges are legal.

## Finding the linked PR

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/finding-pr.md` (both the GitHub-issue and local-issue paths apply here).

## Anti-patterns

- Posting anything to the issue thread, or adding a bookkeeping comment to the pull request. The only GitHub writes are the PR and its `Closes #N`.
- `git add`ing any file under `<repo>.issues/`, or writing an artifact inside the repo tree.
- Trusting an agent's "I wrote the file" over reading the file back; trusting the agent's summary of a QA verdict over the `QA-VERDICT:` line in `qa.md`.
- Launching multiple issues from here. This skill drives exactly one issue; a fleet is several independent background sessions, each its own `/run-pipeline` run.

(The shared hard rules, persist-the-question-before-asking, stop-on-no-answer, only-the-script-moves-status, self-contained `AskUserQuestion` calls, live in the reference files above and bind here too.)

## Done criteria

The issue has advanced to its next resting point: an artifact written for each phase run, the status moved only through the transition script, any open question persisted in `state.json.pendingQuestion` (and nothing else recording it), no comment posted to the issue thread, and the only GitHub writes being the pull request and its `Closes #N`. A re-run reads `state.json` and resumes exactly where this one stopped.
