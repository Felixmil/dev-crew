# debug-pipeline: a bug-focused pipeline

## Purpose

`/run-pipeline` drives a GitHub (or local) issue through `spec -> plan -> build -> QA`. That shape fits a feature, where the first phase answers "what should exist and what must be true when it is done." A bug is different in kind: before anyone can plan a fix, someone has to establish what is actually happening, where, and why. `/debug-pipeline` is the bug counterpart. It swaps the spec phase for an **investigate** phase and otherwise reuses the same crew and the same state machinery.

```
investigate -> plan -> build -> QA
```

The investigate phase produces `investigation.md`: a repo-grounded root-cause analysis (reproduction, the failing code path, the actual cause, blast radius, a regression-test idea), not a requirements document. Everything downstream (plan, build, QA) is the existing crew, with QA taught to also confirm the bug is actually gone.

This document is the design. It is written to be implemented against the current `run-pipeline` skill, the shared `pipeline-transition.sh`, and the existing `planner`/`builder`/`reviewer` agents.

## Decisions locked at design time

1. **New agent, reuse the rest.** One new `investigator` agent. `planner`, `builder`, and `reviewer` are reused. `spec-writer` is not used by this pipeline. Only the first phase differs.
2. **Bug-specific statuses.** `pipeline-transition.sh` gains investigate-oriented edges (`open -> investigated`, the `investigate-awaiting-approval` gate, and a terminal `not-a-bug`). The feature pipeline never emits these; the bug pipeline never emits `spec-ready`. Both share one script.
3. **Investigation can terminate early.** The investigator may conclude `not-a-bug`, `cannot-reproduce`, or `works-as-intended`, which stops the pipeline before plan and surfaces the findings.
4. **Bug-aware QA.** The reviewer additionally confirms the investigation's reproduction no longer triggers and that a regression test covers it.
5. **Same state root.** A bug issue lives under the same `<repo>.issues/<issue>/` folder as any issue, with `investigation.md` where `spec.md` would sit. One state root, one archive, `dependsOn` works across bugs and features.

## The state machine

The shared `pipeline-transition.sh` is the only thing that writes `state.json.status`. The feature path is unchanged. The bug path adds a parallel entry segment that rejoins the shared path at `ready-for-dev`:

```
open
  -> investigated                     investigation done, a real bug to fix
  -> ready-for-dev                     plan done
  -> in-progress -> ai-review
  -> human-review -> closed

open -> not-a-bug                       terminal early exit (see below)

manual-mode gates:
  investigate-awaiting-approval         (open -> gate -> investigated)
  plan-awaiting-approval                (shared, unchanged)
  build-awaiting-approval               (shared, unchanged)
  qa-awaiting-approval                  (shared, unchanged)
```

### New edges to add to `pipeline-transition.sh`

```
"open -> investigated")                        return 0 ;;
"open -> investigate-awaiting-approval")        return 0 ;;
"investigate-awaiting-approval -> investigated") return 0 ;;
"investigated -> ready-for-dev")               return 0 ;;
"investigated -> plan-awaiting-approval")       return 0 ;;
"open -> not-a-bug")                            return 0 ;;
"investigate-awaiting-approval -> not-a-bug")   return 0 ;;
```

Notes on the shape:
- `investigated` is the bug analogue of `spec-ready`. It feeds `ready-for-dev` exactly as `spec-ready` does, so `planner`, `builder`, and `reviewer` see the same downstream states they already handle. No downstream edge changes.
- `investigate-awaiting-approval` is the manual-mode gate, mirroring `spec-awaiting-approval`. It exits on approve to `investigated`, or (if the investigator's verdict was a terminal one and the human confirms) to `not-a-bug`.
- `not-a-bug` is a **terminal** status: it has no outgoing edge. The three early-exit verdicts (`not-a-bug`, `cannot-reproduce`, `works-as-intended`) all map to this one status; the specific verdict is recorded in `investigation.md` and (as a convenience field) in `state.json`, but the machine only needs one terminal sink. This keeps the table small and mirrors how the QA verdict is a string in the artifact rather than a per-value status.
- The idempotent no-op guard and everything else in the script are untouched. All edges stay in the one `allowed()` case statement.

### Why the two pipelines can share the script safely

`run-pipeline`'s phase-loop table maps `entry status -> agent`. It has no row for `open -> investigator` and no row for `investigated`, so it will never drive a bug issue; and `debug-pipeline` has no row for `spec-ready`, so it will never drive a feature issue past investigation. A `state.json` therefore belongs to exactly one pipeline by virtue of which entry segment its first transition took. The script permitting both edge sets does not let one skill wander into the other's states, because each skill only ever issues its own transitions.

## The investigator agent (`agents/investigator.md`)

Modeled on `spec-writer.md`, but its job is diagnosis, not requirements. Same file-based contract: it is handed an absolute path, writes exactly one artifact there, posts nothing to GitHub, and returns a JSON object the caller parses.

### Tools

At minimum the spec-writer's read set, plus the ability to actually run a reproduction: `Read, Grep, Glob, Write, Edit, Bash, Bash(gh issue view *)`. The broad `Bash` is what lets it reproduce the bug (run the failing command, the failing test, a snippet). It still writes only its one artifact and touches no git state.

### Inputs the caller hands it

- The issue (a GitHub number to read with `gh issue view`, or a local `issue.md` path).
- An absolute path where `investigation.md` must be written.
- Possibly read-only paths to dependency issues' artifacts.
- Possibly an answer to a question it raised on an earlier turn.
- Whether it is in auto mode (adopt its own recommended default rather than asking).

### Workflow

1. Load the issue.
2. **Reproduce first.** Establish a concrete, minimal reproduction: the exact command, test, or input that triggers the bug, and the observed-vs-expected behavior. If it cannot reproduce after a genuine effort, that is a first-class outcome, not a failure (see the terminal verdict below).
3. **Trace to root cause.** Read the relevant code and follow the failing path to the actual cause, citing real file paths and line numbers. Distinguish the symptom from the cause.
4. **Assess blast radius.** What else touches the buggy code path; what might a fix affect.
5. **Propose a regression test.** Name what a test should assert so the bug cannot silently return. (The investigator proposes; the builder writes it.)
6. If something material is genuinely ambiguous and only a human can settle it, return `clarification-needed` (unless in auto mode).
7. Otherwise write `investigation.md` and return `done` (or a terminal verdict; see below).

### `investigation.md` structure

A repo-grounded diagnosis, roughly:
- **Summary**: one paragraph, what the bug is.
- **Reproduction**: the exact steps/command/test and observed vs expected.
- **Root cause**: the actual cause with file:line citations, symptom vs cause called out.
- **Blast radius**: what the fix touches, what to watch for.
- **Proposed regression test**: what a test must assert.
- **Verdict line** (last line, mirroring the QA verdict convention):
  `INVESTIGATION-VERDICT: bug-confirmed` — a real bug, proceed to plan.
  `INVESTIGATION-VERDICT: not-a-bug` — works as intended / user error / duplicate.
  `INVESTIGATION-VERDICT: cannot-reproduce` — could not trigger it.

The caller reads this last line, not the agent's return, exactly as QA does. A malformed final line reads as `cannot-reproduce` (the conservative early-exit, never `bug-confirmed`, so a garbled verdict never silently drives a fix).

### Return contract

```
{"status": "done"}
{"status": "clarification-needed", "question": "...", "options": [...], "recommendedDefault": "..."}
```

Same as spec-writer. The early-exit verdict is not a return value; it is the last line of `investigation.md`, so it survives a session death the same way the QA verdict does.

## The bug-aware reviewer

The design reuses `agents/reviewer.md` unchanged and makes it bug-aware **through the caller's prompt**, not through a new agent file. The `/debug-pipeline` skill hands the reviewer the `investigation.md` path alongside `plan.md`, plus one extra instruction block: "This is a bug fix. Beyond mapping the diff to the plan, confirm the reproduction in `investigation.md` no longer triggers, and that a regression test covers it. If the reproduction still triggers or no regression test exists, the verdict is `rejected`." The reviewer's existing `QA-VERDICT: approved|rejected` last-line convention is unchanged.

A separate `bug-reviewer.md` was considered and rejected: it would be almost entirely identical to `reviewer.md`. The one thing that could justify a distinct agent, running an arbitrary reproduction *command* inside the reviewer, is avoidable: the regression test lands in the pull request diff, and the reviewer already reads the diff (`git diff`/`gh pr diff`), so it confirms the test exists without new tools. If a future case genuinely needs the reviewer to *execute* a reproduction rather than read a test, that is a one-line tools grant on `reviewer.md` (adding a scoped `Bash`), revisited then rather than duplicated now.

## The `/debug-pipeline` skill

A near-clone of `run-pipeline/SKILL.md` with these differences, and nothing else:

### Phase-loop table

| Phase | Entry status | Agent | On success -> |
| --- | --- | --- | --- |
| investigate | `open` | `dev-crew:investigator` | `investigated` (bug-confirmed) or `not-a-bug` (terminal) |
| plan | `investigated` | `dev-crew:planner` | `ready-for-dev` |
| build | `ready-for-dev`, `in-progress`, `blocked` | `dev-crew:builder` | first `in-progress`, then `ai-review` |
| qa | `ai-review` | `dev-crew:reviewer` (bug-aware) | `human-review` (approved) or `in-progress` (rejected) |

The plan/build/QA rows are identical to `run-pipeline` except the artifact handed as "the contract" is `investigation.md` instead of `spec.md`. The planner is handed `investigation.md` as its input document; the builder is handed `investigation.md` and `plan.md`; the reviewer is handed `investigation.md` and `plan.md` plus the bug-aware instruction.

### Investigate phase specifics

- After the investigator returns `done`, read `investigation.md` back and parse the last `INVESTIGATION-VERDICT:` line (mirroring the QA-verdict read).
- **`bug-confirmed`**: transition `open -> investigated` (through `investigate-awaiting-approval` in manual mode), continue to plan.
- **`not-a-bug` / `cannot-reproduce` / `works-as-intended`**: this is the early exit. Transition `open -> not-a-bug` (a terminal status), surface the findings to the user inline (the summary and the reason), and stop. Record the specific verdict in `state.json` (a convenience field like `investigationVerdict`, not the gated `status`). In `manual` mode, hit the investigate gate first and let the human confirm the early exit or send it back for a deeper look (`revise`).
- Everything else about the phase (clarification handling, the resumable pending-question flow, reading the artifact back rather than trusting the return) is identical to the spec phase.

### QA phase specifics

Identical to `run-pipeline` (verdict from the last line of `qa.md`, reject loops back to build up to 3 attempts, approve flips the draft PR to ready), with the one addition that the reviewer is invoked with the bug-aware instruction and `investigation.md` path.

### Everything else is unchanged

Setup, state-root derivation, local-issue handling (`L`-prefixed), the single validated status mutator, the resumable `pendingQuestion` flow, the three modes on two orthogonal axes, `dependsOn`, finding the linked PR, and the done criteria are all copied from `run-pipeline` verbatim. The bug pipeline stops at `human-review`; `/merge-pr` still merges, and it already archives the folder regardless of which pipeline drove the issue.

## What has to change, concretely

1. **`scripts/pipeline-transition.sh`**: add the seven bug edges listed above to the `allowed()` case. Nothing else in the script changes.
2. **`agents/investigator.md`**: new file, modeled on `spec-writer.md`, per the section above.
3. **`skills/debug-pipeline/SKILL.md`**: new file, a near-clone of `run-pipeline/SKILL.md` with the investigate phase and the bug-aware QA prompt.
4. **`agents/reviewer.md`**: no change if we go with prompt-only bug-awareness (recommended); the skill supplies the extra instruction and the `investigation.md` path.
5. **`README.md`**: document the new skill and the investigator agent alongside the existing pipelines.
6. **`.claude-plugin/plugin.json`**: register the new agent/skill if it enumerates them (verify; the plugin may auto-discover the `agents/` and `skills/` directories, in which case no change is needed).

## Settled decisions (were open questions)

1. **Bug-aware reviewer is prompt-only.** No `bug-reviewer.md`; the skill supplies the extra instruction and the `investigation.md` path to the existing reviewer. See the reviewer section above.
2. **`refine-issue` gets no bug mode.** The investigator reproduces and roots-cause anyway, so a separate refine pass is redundant for bugs. `refine-issue` is untouched.
3. **A `not-a-bug` early exit does not auto-archive in v1.** The skill surfaces the verdict and stops at the terminal status; moving the folder out of the active set is a manual step. Auto-archiving on the terminal verdict can be added later if it proves worth it.
