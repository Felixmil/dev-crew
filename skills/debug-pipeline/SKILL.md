---
name: debug-pipeline
description: Drives one bug (a GitHub issue number, or a local L-prefixed issue) through investigate -> plan -> build -> QA, keeping the artifacts and state machine under <repo>.issues/<issue>/ and every human question inline. The bug counterpart to /run-pipeline: an investigate phase replaces spec, and QA additionally confirms a regression test covers the cited root cause. Use when the user says "debug N", "run the debug pipeline on N", "investigate and fix bug N", passes a mode, or invokes /debug-pipeline with an issue number.
---

# Bug pipeline

You drive one bug issue through investigate -> plan -> build -> QA. This is the bug counterpart to `/run-pipeline`: the spec phase is replaced by an **investigate** phase that reproduces the bug and traces it to its root cause, and QA additionally confirms a regression test covers that root cause so the bug cannot silently return. Everything else, the state root, the shared machinery, the modes, the resumable question flow, is the file-based pipeline's, shared through the same reference files.

You run in this session's own context, so you own every `AskUserQuestion` and every file read/write directly; you spawn the four file-writing subagents and hand each one concrete filesystem paths. The four artifacts (`investigation.md`, `plan.md`, `build.md`, `qa.md`), the state (`state.json`), and every human question live on the local filesystem and in this session. The GitHub issue is only the input; a pull request is only the ship channel. You never post a comment to the issue thread, and you never add a bookkeeping comment to the pull request.

This skill shares its machinery through reference files under `${CLAUDE_PLUGIN_ROOT}/references/pipeline/`. Read each one at the point the sections below send you to it, and follow it exactly; this `SKILL.md` carries only the bug-pipeline delta over `/run-pipeline`.

## Mission

Take the bug from wherever `state.json` says it is to the next resting point, writing each phase's artifact to disk, advancing the state only through the transition script, and surfacing every question inline in a way that survives the session being killed. Where you are is always read from `state.json`. The investigate phase may conclude the report is not a bug and stop the pipeline early.

## Setup

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/state-and-setup.md`. This pipeline fills its deltas as follows:

- **State root**: `<parent>/<repo>.issues`, derived from git exactly as `/run-pipeline` does. This is the same root the feature pipeline uses; a bug and a feature issue share one state root, one archive, and one `dependsOn` space.
- **Seed object**: the standard fields plus one extra, `investigationVerdict: null` (a convenience field, not the gated `status`).
- **Archive check (before bootstrap)**: identical to `/run-pipeline`; a folder already under `<root>/archive/<issue>/` is merged and shipped, so stop rather than re-bootstrap.

**Local issues** (`L`-prefixed) behave exactly as in `/run-pipeline`: read `<root>/<id>/issue.md` instead of `gh issue view`, and the PR references the local id in text rather than `Closes #N`.

## Resume and raising questions

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/raising-questions.md` exactly.

## The phase loop

Read `state.json.status` and drive the phase whose entry status matches:

| Phase | Entry status | Agent | On success -> |
| --- | --- | --- | --- |
| investigate | `open` | `dev-crew:investigator` | `investigated` (bug-confirmed) or `not-a-bug` (terminal early exit) |
| plan  | `investigated` | `dev-crew:planner` | `ready-for-dev` |
| build | `ready-for-dev`, `in-progress`, `blocked` | `dev-crew:builder` | first `in-progress`, then `ai-review` |
| qa    | `ai-review` | `dev-crew:reviewer` (bug-aware) | `human-review` (approved) or `in-progress` (rejected) |

Every bug runs the full investigate -> plan -> build -> QA path, except that the investigate phase may conclude the report is not a real bug and stop the pipeline at the terminal `not-a-bug` status before plan. The transition script has no `open -> in-progress` fast-path edge, so an investigation is always produced first.

The per-phase loop steps (compute paths, resolve dependencies, invoke with a `schema`, handle `clarification-needed`, read the artifact back on `done`, apply the artifact-approval gate, advance) are the file-based pipeline's, with these bug deltas:

- **The artifacts are `investigation.md`, `plan.md`, `build.md`, `qa.md`.**
- **The plan, build, and QA agents take `investigation.md` where they would normally take `spec.md`.** The planner is handed `investigation.md` as its input document; the builder is handed `investigation.md` and `plan.md`; the reviewer is handed `investigation.md` and `plan.md`. Tell each in the prompt that this document is a bug investigation (reproduction, root cause, blast radius, proposed regression test), not a feature spec, so it plans, builds, and reviews the fix against the diagnosis. The agents read whatever path they are handed; only the prompt framing differs.
- **Dependencies** resolve per `${CLAUDE_PLUGIN_ROOT}/references/pipeline/depends-on.md`. A depended-on issue may be a feature (with `spec.md`) or a bug (with `investigation.md`); pass whichever upstream artifacts exist, plus its `plan.md`, with the `<root>/archive/D/` fallback.

### Investigate phase specifics

- After the investigator returns `done`, read `investigation.md` back and parse the last `INVESTIGATION-VERDICT:` line (mirroring the QA-verdict read). Trust the file, not the agent's return. A missing or malformed final line reads as `cannot-reproduce` (the conservative early exit, never `bug-confirmed`, so a garbled verdict never silently drives a fix). Record the parsed verdict in `state.json.investigationVerdict`.
- **`bug-confirmed`**: a real bug. Transition `open -> investigated` and continue to plan. In `manual` mode, hit the investigate approval gate first (`open -> investigate-awaiting-approval`, then on approve `-> investigated`), exactly as the spec gate works.
- **`not-a-bug` / `cannot-reproduce` / `works-as-intended`**: the early exit. Surface the finding to the user inline (the summary and reason, drawn from `investigation.md`), then transition to the terminal `not-a-bug` status (`open -> not-a-bug`, or in `manual` mode via `open -> investigate-awaiting-approval -> not-a-bug` once the human confirms) and stop the pipeline. Do not proceed to plan. In `manual` mode the investigate gate offers two branches on an early-exit verdict: confirm the early exit (advance to `not-a-bug` and stop), or revise (re-run the investigator for a deeper look, e.g. with a hint, and re-parse the verdict). `not-a-bug` is terminal and has no outgoing edge; the issue folder is not auto-archived (move it out of the active set by hand if you want).

### Build phase specifics

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/build-phase.md`. Delta: the builder **owns the PR body**, opening/updating the PR with a clean `Closes #<issue>` body (a local-id reference line, no `Closes`, for a local issue).

### QA phase specifics

- The reviewer is invoked **bug-aware**: hand it `investigation.md` and `plan.md`, plus this extra instruction in the prompt: "This is a bug fix. Beyond mapping the diff to the plan, verify from the diff that a regression test exists and that it covers the root cause cited in investigation.md, so the bug cannot silently return. If no regression test covers the cited root cause, the verdict is rejected." The reviewer reasons from the diff; it does not re-run the reproduction (its tooling is read-only). Its `<!-- QA-VERDICT: approved|rejected -->` HTML-comment last-line convention is unchanged.
- Read the verdict from the last `QA-VERDICT:` line in `qa.md`, not from the agent's return.
- In `auto`/`semi-auto`: on `rejected`, route `qa.md` plus the rejection back to the **build** agent as fixup feedback, transition `ai-review -> in-progress`, re-run build, transition back to `ai-review`, re-run QA. Repeat up to 3 total build attempts; if still rejected, leave the issue at `in-progress` for a human and stop. On `approved`, transition `ai-review -> human-review`.
- In `manual`: after writing `qa.md`, hit the QA approval gate (modes reference).
- **Flip the PR out of draft on the way into `human-review`** with `gh pr ready <pr>` (re-derive `<pr>` fresh), in every mode when the transition into `human-review` happens. Idempotent; a failure here is a soft warning.

## Modes

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/modes.md`. The investigate approval gate has one extra branch over the others: on an early-exit verdict (`not-a-bug`/`cannot-reproduce`/`works-as-intended`), `approve` confirms the early exit and advances to the terminal `not-a-bug`, while `revise` re-runs the investigator for a deeper look. On a `bug-confirmed` verdict it behaves like the spec gate.

## The status list

Statuses are bare (no `status:` prefix). The bug pipeline uses: `open`, `investigated`, `ready-for-dev`, `in-progress`, `blocked`, `ai-review`, `human-review`, `closed`, the terminal `not-a-bug`, and the four gates `investigate-awaiting-approval`, `plan-awaiting-approval`, `build-awaiting-approval`, `qa-awaiting-approval`. It never emits `spec-ready` or `spec-awaiting-approval` (those are the feature pipeline's). The transition script's edge table is the single source of truth for which edges are legal.

## Finding the linked PR

Follow `${CLAUDE_PLUGIN_ROOT}/references/pipeline/finding-pr.md` (both the GitHub-issue and local-issue paths apply here).

## Anti-patterns

- Proceeding to plan on an early-exit verdict. `not-a-bug`, `cannot-reproduce`, and `works-as-intended` all stop the pipeline at the terminal `not-a-bug` status; never plan or build a fix for a bug the investigation could not confirm.
- Trusting the investigator's return over the `INVESTIGATION-VERDICT:` line in `investigation.md`; a malformed final line reads as `cannot-reproduce`, never `bug-confirmed`.
- Posting anything to the issue thread, or adding a bookkeeping comment to the pull request. The only GitHub writes are the PR and its `Closes #N`.
- `git add`ing any file under `<repo>.issues/`, or writing an artifact inside the repo tree.
- Trusting an agent's "I wrote the file" over reading the file back; trusting the agent's summary of a QA verdict over the `QA-VERDICT:` line in `qa.md`.
- Launching multiple issues from here. This skill drives exactly one bug; a fleet is several independent background sessions, each its own `/debug-pipeline` run.

(The shared hard rules, persist-the-question-before-asking, stop-on-no-answer, only-the-script-moves-status, self-contained `AskUserQuestion` calls, live in the reference files above and bind here too.)

## Done criteria

The bug has advanced to its next resting point: an investigation written and either confirmed (moving through plan, build, QA) or concluded not a bug (stopped at the terminal `not-a-bug`), an artifact written for each phase run, the status moved only through the transition script, any open question persisted in `state.json.pendingQuestion` (and nothing else recording it), no comment posted to the issue thread, and the only GitHub writes being the pull request and its `Closes #N`. A re-run reads `state.json` and resumes exactly where this one stopped.
