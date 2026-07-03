---
name: merge-pr
description: Safely squash-merges a finished pull request after checking gates, its CI is green, it is actually mergeable (no conflicts, not blocked by missing required reviews), and it does not require bypassing branch-protection rules without your say-so. Surfaces any red gate to you via AskUserQuestion rather than merging blindly, and loudly asks before using an admin rule-bypass. Works on any PR, whether or not a dev-crew pipeline drove it; if the PR maps to a pipeline issue, it marks that issue closed afterward. Use when the user says "merge PR N", "merge this PR", or invokes /merge-pr with a PR number.
---

# Merge PR

You squash-merge one finished pull request, but only after its gates are
green, and you never bypass a branch-protection rule without explicit
permission. You take a **PR number** (not an issue). The merge itself is
the easy part; your real job is the safety gates before it.

## Guiding principle

A merge is irreversible-ish and outward-facing. So: check every gate,
surface anything red to the human rather than deciding for them, and treat
an admin rule-bypass as a loud, explicit, opt-in action, never a silent
convenience. When in doubt, ask; do not merge.

## What you are handed

- A **PR number** (required).
- Optionally, steering (e.g. "merge PR 42 even though CI is red" pre-
  authorizes the CI gate; honor it but still run the other gates).

## Setup

1. **Resolve the repo**: `gh repo view --json owner,name,nameWithOwner`.
2. **Load the PR**: `gh pr view <pr> --json number,title,headRefName,state,mergeable,mergeStateStatus,url`.
   If `state` is not `OPEN` (already merged/closed), say so and stop.

## The gates (run in order; stop and ask on any red one)

### Gate 1: mergeability (conflicts / blocked / still computing)

Read `mergeable` and `mergeStateStatus` from the PR.

- **Still computing:** if `mergeable` is `UNKNOWN` or `mergeStateStatus`
  is `UNKNOWN`, GitHub is recomputing (common right after a push). Wait
  a few seconds and re-read, up to ~5 tries, before treating it as real.
- **Conflicts:** if `mergeable` is `CONFLICTING` or `mergeStateStatus`
  is `DIRTY`, the PR has merge conflicts. Do **not** merge. Tell the user
  to resolve them (the `/update-branch` skill can help), and stop.
- **Behind base:** if `mergeStateStatus` is `BEHIND`, the branch needs
  updating against base first. Stop and tell the user (the `/update-branch`
  skill brings it up to date); do not silently rebase/merge base in
  yourself.
- **Blocked:** if `mergeStateStatus` is `BLOCKED`, it is blocked by
  branch protection (missing required review, failing/omitted required
  check, or a ruleset). This feeds Gate 3 (bypass); do not fail yet.
- **Clean:** `mergeStateStatus` `CLEAN` (or `UNSTABLE`/`HAS_HOOKS` with
  otherwise-passing checks) means the normal merge path is open.

### Gate 2: CI checks

Run `gh pr checks <pr>`. Interpret by exit code (and confirm with the
`bucket` field if you need detail via `gh pr checks <pr> --json name,bucket,state`):

- **exit 0** — all checks passed. Gate green.
- **exit 8** — checks are still **pending/running**. Do not merge into a
  pending state. Ask the user via `AskUserQuestion` whether to wait and
  re-check, or stop. Do not merge while pending unless they explicitly say
  to.
- **any other non-zero** — one or more checks **failed** (`bucket` ==
  `fail`). This is the "some are red" case: **ask the user via
  `AskUserQuestion`** whether to proceed with the merge anyway or stop,
  naming which checks failed. Only proceed if they choose to. (If the
  steering already said "merge even though CI is red," treat that as the
  answer, but still name the failed checks in your report.)

### Gate 3: branch-protection bypass (the loud one)

Only relevant when Gate 1 found `mergeStateStatus: BLOCKED`.

A blocked PR cannot merge through the normal path. `gh pr merge --admin`
bypasses the protection, but only if the current user is a repo admin.
Before ever using `--admin`:

1. Check the user's permission:
   `gh api repos/<owner>/<repo>/collaborators/$(gh api user --jq .login)/permission --jq .permissions.admin`
   (wrap so a 404 / non-collaborator reads as `false`).
2. **If the user is NOT an admin:** they cannot bypass. Stop and report
   that the PR is blocked by branch protection (name what is missing if
   you can tell, e.g. a required review) and that you lack rights to
   bypass. Do not attempt `--admin`.
3. **If the user IS an admin:** merging would require **bypassing the
   repository's branch-protection rules**. Do **not** do this silently.
   Ask via `AskUserQuestion`, stating plainly that the PR is blocked
   (and why, if known), that proceeding will **bypass branch-protection
   rules** using admin rights, and offering: bypass and merge
   (not the recommended default), or stop. Only pass `--admin` if they
   explicitly choose to bypass.

## Merging

Once the gates are satisfied (clean, or the human authorized proceeding
past a red CI gate and/or an admin bypass):

```
gh pr merge <pr> --squash --delete-branch [--admin]
```

Add `--admin` **only** when Gate 3's bypass was explicitly authorized.
Check the exit code: non-zero is a hard failure, report the stderr and do
not retry with `--admin` to force it unless the user authorized a bypass.

## Closing the pipeline issue (best-effort)

A PR may or may not have been driven by a dev-crew pipeline. After a
successful merge, try to close its pipeline state, but never fail the
merge over this:

1. Find the issue this PR belongs to. Prefer the PR body's `Closes #N`
   (GitHub issue) or a referenced local `L`-id. Derive the two possible
   state roots:
   - file-based pipeline: `<parent>/<repo>.issues/<issue>/`
   - gh-posting pipeline: `~/.claude/dev-crew/<repo>/<issue>/`
   (derive `<repo>`/`<parent>` from git as the pipelines do).
2. If a `state.json` exists at either root for that issue, transition it
   to `closed` via the shared script:
   `bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-transition.sh" <that-root> <issue> closed`
   (check the exit code; a non-zero here is a soft warning, the merge
   already happened).
3. If no `state.json` is found in either root, that is fine, the PR was
   not pipeline-driven. Do nothing further; just report the merge.

## Anti-patterns

- Merging while CI is failing or pending without asking. Both are gates;
  surface them and let the user decide.
- Using `--admin` to bypass branch protection without an explicit, loud
  opt-in. Bypassing rules is never the silent-default path.
- Merging a `CONFLICTING`/`DIRTY` PR, or a `BEHIND` one, by forcing it.
  Stop and hand it back to the user (or `/update-branch`).
- Treating a transient `UNKNOWN` merge state as a real blocker without
  polling a few times first.
- Failing the whole action because the pipeline `state.json` could not be
  closed. The merge is the deliverable; closing state is best-effort.
- Deciding a gate on the user's behalf. Every red gate is an
  `AskUserQuestion`, with all the context inside the question.

## Done criteria

The PR is squash-merged and its branch deleted, having passed every gate
or had each red gate explicitly authorized by the user (CI-red proceed,
and/or an admin branch-protection bypass). If the PR mapped to a pipeline
issue, that issue's `state.json` was moved to `closed` (best-effort). If
any gate was red and the user declined, nothing was merged and you
reported exactly which gate stopped it.
