---
name: merge-pr
description: Safely squash-merges a finished pull request only after its gates are green (mergeable, CI passing, no branch-protection bypass without your say-so), surfacing any red gate to you rather than merging blindly. Works on any PR; if it maps to a dev-crew pipeline issue, marks that issue closed afterward. Use when the user says "merge PR N", "merge this PR", or invokes /merge-pr with a PR number.
---

# Merge PR

You squash-merge one finished pull request, but only after its gates are green, and you never bypass a branch-protection rule without explicit permission. You take a **PR number** (not an issue). The merge itself is the easy part; your real job is the safety gates before it.

## Guiding principle

The toolkit's standing stance, **act on the provably safe, escalate the judgment call, never guess**, applied to an irreversible-ish, outward-facing action: check every gate, surface anything red to the human rather than deciding for them, and treat an admin rule-bypass as a loud, explicit, opt-in action, never a silent convenience. When in doubt, ask; do not merge.

## What you are handed

- A **PR number** (required).
- Optionally, steering (e.g. "merge PR 42 even though CI is red" preauthorizes the CI gate; honor it but still run the other gates).

## Setup

1. **Resolve the repo**: `gh repo view --json owner,name,nameWithOwner`.
2. **Load the PR**: `gh pr view <pr> --json number,title,headRefName,baseRefName,state,mergeable,mergeStateStatus,url`. If `state` is not `OPEN` (already merged/closed), say so and stop.

## The gates (run in order; stop and ask on any red one)

### Gate 1: mergeability (conflicts / blocked / still computing)

Read `mergeable` and `mergeStateStatus` from the PR.

- **Still computing:** if `mergeable` is `UNKNOWN` or `mergeStateStatus` is `UNKNOWN`, GitHub is recomputing (common right after a push). Wait a few seconds and re-read, up to ~5 tries, before treating it as real.
- **Conflicts:** if `mergeable` is `CONFLICTING` or `mergeStateStatus` is `DIRTY`, the PR has merge conflicts. Do **not** merge. Tell the user to resolve them (the `/update-branch` skill can help), and stop.
- **Behind base:** if `mergeStateStatus` is `BEHIND`, the branch needs updating against base first. Stop and tell the user (the `/update-branch` skill brings it up to date); do not silently rebase/merge base in yourself.
- **Blocked:** if `mergeStateStatus` is `BLOCKED`, it is blocked by branch protection (missing required review, failing/omitted required check, or a ruleset). This feeds Gate 3 (bypass); do not fail yet.
- **Clean:** `mergeStateStatus` `CLEAN` (or `UNSTABLE`/`HAS_HOOKS` with otherwise-passing checks) means the normal merge path is open.

### Gate 2: CI checks

Run `gh pr checks <pr>`. Interpret by exit code (and confirm with the `bucket` field if you need detail via `gh pr checks <pr> --json name,bucket,state`):

- **exit 0** — all checks passed. Gate green.
- **exit 8** — checks are still **pending/running**. Do not merge into a pending state. Ask the user via `AskUserQuestion` whether to wait and re-check, or stop. Do not merge while pending unless they explicitly say to.
- **any other non-zero** — one or more checks **failed** (`bucket` == `fail`). This is the "some are red" case: **ask the user via `AskUserQuestion`** whether to proceed with the merge anyway or stop, naming which checks failed. Only proceed if they choose to. (If the steering already said "merge even though CI is red," treat that as the answer, but still name the failed checks in your report.)

### Gate 3: branch-protection bypass (the loud one)

Only relevant when Gate 1 found `mergeStateStatus: BLOCKED`.

A blocked PR cannot merge through the normal path. `gh pr merge --admin` bypasses the protection, but only if the current user is a repo admin. Before ever using `--admin`:

1. Check the user's permission: `gh api repos/<owner>/<repo>/collaborators/$(gh api user --jq .login)/permission --jq .permissions.admin` (wrap so a 404 / non-collaborator reads as `false`).
2. **If the user is NOT an admin:** they cannot bypass. Stop and report that the PR is blocked by branch protection (name what is missing if you can tell, e.g. a required review) and that you lack rights to bypass. Do not attempt `--admin`.
3. **If the user IS an admin:** merging would require **bypassing the repository's branch-protection rules**. Do **not** do this silently. Ask via `AskUserQuestion`, stating plainly that the PR is blocked (and why, if known), that proceeding will **bypass branch-protection rules** using admin rights, and offering: bypass and merge (not the recommended default), or stop. Only pass `--admin` if they explicitly choose to bypass.

## Merging

Once the gates are satisfied (clean, or the human authorized proceeding past a red CI gate and/or an admin bypass):

```
gh pr merge <pr> --squash --delete-branch [--admin]
```

Add `--admin` **only** when Gate 3's bypass was explicitly authorized. Check the exit code: non-zero is a hard failure, report the stderr and do not retry with `--admin` to force it unless the user authorized a bypass.

`--delete-branch` deletes the **remote** head branch. The local branch and any worktree are cleaned up next.

## Cleaning up the merged branch and worktree (best-effort)

After a successful squash-merge, the head branch's commits are in the base branch, so the local head branch and any worktree that held it are dead weight. Remove them, but guard every destructive step and never fail the merge over this (the merge is the deliverable; this is housekeeping):

1. **The head branch** is `headRefName` from the PR (loaded in Setup).
2. **Find a worktree for it.** Run `git worktree list --porcelain` and look for a worktree whose branch is `headRefName`. By this toolkit's convention it lives at `<parent>/<repo>.worktrees/<headRefName>/`, but trust `git worktree list` over the convention.
3. **Remove the worktree, with guards.** Only if a worktree for `headRefName` exists and it is **not the one you are currently in** (compare against `git rev-parse --show-toplevel`): run `git worktree remove <path>`. If it refuses because the worktree is dirty (uncommitted changes unrelated to the merged work), **do not** force it, skip with a warning naming the path so the user can deal with it. Never remove the worktree you are standing in; warn instead.
4. **Delete the local branch, with guards.** Only after any worktree for it is gone (git will not delete a branch checked out in a live worktree). A squash-merge collapses the branch's commits into a single new commit on base, so `git branch -d <headRefName>` will usually refuse with "not fully merged" (the original commits are not ancestors of base). Because the PR **was** merged, the branch content is safely in base, so `git branch -D <headRefName>` is the right call here. If the branch is still checked out somewhere (the current HEAD, or a worktree you could not remove), skip with a warning rather than forcing.
5. **If there is no local branch and no worktree** (the PR was merged from a branch you never had locally, common when merging someone else's PR), there is nothing to clean; say so and move on.

Every step here is best-effort: a skipped or failed cleanup is a soft warning in your report, never a merge failure.

## Syncing the local base branch (best-effort)

The squash-merge landed on the **remote** base branch, so `origin/<base>` now has the merge commit but your local base branch is one commit behind. Bring it up to date, but only when it is unambiguously safe, and never fail the merge over it:

1. The base branch is `baseRefName` from the PR (loaded in Setup).
2. **Only sync when you are standing on the base branch with a clean tree.** Check the current branch (`git rev-parse --abbrev-ref HEAD`) against `baseRefName`, and the working tree (`git status --porcelain`) for cleanliness. If the current branch is not `baseRefName` (you are in a feature worktree or on another branch), or the tree is dirty, **skip with a warning** naming the base branch so the user can pull it themselves. Do not switch branches to force the pull.
3. **Fast-forward only.** When the guard passes, run `git pull --ff-only origin <baseRefName>`. `--ff-only` means the pull can only move the branch straight forward to `origin/<base>`; it can never create a merge commit and never produce a conflict. If it cannot fast-forward (local base has diverged from the remote), it fails harmlessly, treat that as a skip-with-warning, not a merge failure.

This is best-effort like the cleanup: a skipped or failed sync is a soft warning in your report, never a merge failure.

## Closing the pipeline issue (best-effort)

A PR may or may not have been driven by a dev-crew pipeline. After a successful merge, try to close its pipeline state, but never fail the merge over this:

1. Find the issue this PR belongs to. Prefer the PR body's `Closes #N` (GitHub issue) or a referenced local `L`-id. Derive the two possible state roots:
   - file-based pipeline: `<parent>/<repo>.issues/<issue>/`
   - gh-posting pipeline: `~/.claude/dev-crew/<repo>/<issue>/` (derive `<repo>`/`<parent>` from git as the pipelines do).
2. If a `state.json` exists at either root for that issue, transition it to `closed` via the shared script: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-transition.sh" <that-root> <issue> closed` (check the exit code; a non-zero here is a soft warning, the merge already happened).
3. **Archive the merged issue (file-based pipeline only).** After a successful `closed` transition on the **file-based** root (`<parent>/<repo>.issues/`), move the issue folder out of the active set into an `archive/` subfolder of that same root, so the active directory holds only live issues: `mkdir -p "<root>/archive" && mv "<root>/<issue>" "<root>/archive/<issue>"`. This applies **only** to the file-based root; the gh-posting root (`~/.claude/dev-crew/<repo>/`) is left as is (it is hidden state, not a browsable working set). Guard the move: if `<root>/archive/<issue>` already exists (a re-run after a prior merge), do not clobber it, the issue is already archived; skip the move. Like the close, this is best-effort: a failed move is a soft warning, never a merge failure.
4. If no `state.json` is found in either root, that is fine, the PR was not pipeline-driven. Do nothing further; just report the merge.

## Anti-patterns

- Merging while CI is failing or pending without asking. Both are gates; surface them and let the user decide.
- Using `--admin` to bypass branch protection without an explicit, loud opt-in. Bypassing rules is never the silent-default path.
- Merging a `CONFLICTING`/`DIRTY` PR, or a `BEHIND` one, by forcing it. Stop and hand it back to the user (or `/update-branch`).
- Treating a transient `UNKNOWN` merge state as a real blocker without polling a few times first.
- Failing the whole action because the pipeline `state.json` could not be closed, a branch/worktree could not be cleaned up, or the local base branch could not be synced. The merge is the deliverable; closing state, cleanup, and the base sync are best-effort.
- Pulling the base branch when you are not on it or the tree is dirty, or with anything but `--ff-only`. Only fast-forward the base branch, only when standing on it clean; otherwise skip with a warning.
- Force-removing a **dirty** worktree, or removing the worktree you are currently standing in, or force-deleting a branch still checked out somewhere. Guard each and skip-with-warning instead of forcing.
- Deciding a gate on the user's behalf. Every red gate is an `AskUserQuestion`, with all the context inside the question.

## Done criteria

The PR is squash-merged and its remote branch deleted, having passed every gate or had each red gate explicitly authorized by the user (CI-red proceed, and/or an admin branch-protection bypass). The local head branch and any worktree that held it were removed (best-effort, guarded: a dirty worktree, the current worktree, or a branch checked out elsewhere is skipped with a warning). If the local checkout was on the PR's base branch with a clean tree, that base branch was fast-forwarded to the merge commit (best-effort; skipped with a warning otherwise). If the PR mapped to a pipeline issue, that issue's `state.json` was moved to `closed` (best-effort), and for a file-based issue its folder was moved into `<repo>.issues/archive/` (best-effort, skipped if already archived). If any gate was red and the user declined, nothing was merged and you reported exactly which gate stopped it.
