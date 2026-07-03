---
name: address-pr
description: Takes a pull request number and brings it back to green and to a resolved review state. Investigates and fixes CI/CD failures, and evaluates reviewer comments, addressing the valid ones (fixing the code, pushing, and replying) while skipping the invalid ones with a reasoned note. Grounds validity in the issue's agreed spec.md/plan.md so fixes stay in PR scope. Use when the user says "fix the CI on PR N", "address the review comments on PR N", "the PR is red, fix it", or invokes /address-pr with a PR number (optionally with steering, e.g. "/address-pr 42 only the failing test").
---

# Address PR

You take one pull request and drive it toward mergeable: **fix its CI/CD
failures** and **address its valid review comments**. You do the actual
code changes by delegating to the `builder` (invoke it with
that exact `subagent_type`; it knows how to write repo-quality code and
push to a PR branch), and you own the investigation, the validity
judgment, and the reviewer communication.

Your guiding principle mirrors the rest of this toolkit: **fix what is
clearly right, escalate genuine judgment calls, never act blindly.** A
reviewer comment is not automatically an instruction, and a red check is
not automatically a code defect.

## What you are handed

- A **PR number** (required).
- Optional **free-form steering** after it. This is NOT limited to a
  fixed `ci`/`reviews` mode; honor whatever the user says. Examples:
  - `/address-pr 42` — do whatever the PR needs (auto-detect, below).
  - `/address-pr 42 ci` — only the CI failures.
  - `/address-pr 42 reviews` — only the review comments.
  - `/address-pr 42 just the failing R-CMD-check` — scope to that check.
  - `/address-pr 42 focus on the reviewer's error-handling concern` —
    scope to specific feedback.
  Read the steering and let it narrow or direct the work; with no
  steering, auto-detect what the PR needs.

## Setup

1. **Load the PR**: `gh pr view <PR> --json number,title,body,headRefName,baseRefName,state,url` and
   `gh pr diff <PR>`. Note the head branch (the builder works on it) and the
   base branch (the target it merges into).
2. **Bring the branch up to date with its target first.** A branch that is
   behind its base can show CI failures or attract review comments that the
   target branch has *already* fixed, so syncing before you diagnose avoids
   chasing problems that no longer exist. Delegate this to the
   `update-branch` skill (it merges `baseRefName` into the head branch,
   never a rebase, so review threads and comment anchors survive, and drives
   the conflict resolver if the merge conflicts). If it brought changes in,
   push the updated branch and re-read the PR state (checks and comments)
   against it before proceeding. If the branch is already current,
   `update-branch` says so and there is nothing to sync.
3. **Find the issue's spec/plan for grounding.** The agreed spec and plan
   are what make a review comment "valid" or "out of scope", so locate
   them:
   - **Primary (reverse-lookup):** derive the state root from git
     (`<parent>/<repo>.issues`), then find the issue folder whose
     `state.json.prNumber` equals this PR number. That folder's `spec.md`
     and `plan.md` are the grounding.
   - **Fallback (PR body):** if no `state.json` matches, parse the PR
     body: a `Closes #N` points to `<root>/N/`; a local-issue PR
     references its `L`-id in text pointing to `<root>/L#/`.
   - **If neither resolves** (PR made outside the pipeline): proceed
     **without** spec/plan grounding, and say so explicitly, you will
     judge comments on code merit alone, and cannot check scope against a
     contract. Do not invent a spec/plan.
4. **Auto-detect the work** (unless steering narrows it): run
   `gh pr checks <PR>` to see if any check is failing (the CI job), and
   read the review comments (the reviews job). Do whichever apply; do both
   if both apply.

## Job 1: CI/CD failures

1. **Identify the failing checks**: `gh pr checks <PR>` lists each check
   and its state. For each failing one, read its logs:
   `gh run view <run-id> --log-failed` (get the run id from the check's
   details link, or `gh run list --branch <headRefName>`).
2. **Diagnose the root cause per failing check.** Distinguish a real code
   defect (a failing test, a lint error, a broken build, an R CMD check
   NOTE/WARNING/ERROR) from an infra/flaky failure (a timeout, a network
   error, a runner hiccup, a cache miss). Only code defects are yours to
   fix; for an infra/flaky failure, say so and do not "fix" code that is
   not broken (a re-run is the remedy, which you may note but not trigger
   blindly).
3. **Fix code defects** by delegating to the builder: hand it
   the PR number, the head branch, the failing check's diagnosis and log
   excerpt, and the spec/plan paths (so the fix stays in scope). It makes
   the change, pushes to the PR branch, and updates the build summary.
4. **Re-check**: after pushing, confirm the fix by re-reading
   `gh pr checks <PR>` (the checks re-run on push). If still red for the
   same reason, iterate a bounded number of times (default 3 total
   attempts per check); if still failing, stop and report the remaining
   failure rather than thrash.
5. If a fix is **ambiguous** (more than one plausible root cause, or the
   fix would change behavior in a way the spec/plan does not cover),
   escalate via `AskUserQuestion` before pushing, do not guess on a
   behavior change.

## Job 2: review comments

1. **Collect the comments.** There are two kinds, handled differently at
   reply time (below): **inline review comments** (attached to specific
   lines, from `gh api repos/{owner}/{repo}/pulls/<PR>/comments`) and
   **general PR comments / review summaries**
   (`gh pr view <PR> --json comments,reviews`). Read them all, including
   any prior replies, so you do not re-address something already handled.
2. **Classify each comment against the code AND the spec/plan:**
   - **Clearly valid + mechanical** (a real bug, a typo, a missing test,
     a naming/consistency fix that matches repo conventions, a documented
     edge case not handled): **fix it** via the builder.
   - **Invalid or misguided** (based on a misreading, asks for something
     the code already does, contradicts an established repo convention or
     a passing test's guarantee): **skip it**, with a brief, specific,
     respectful reason.
   - **Out of PR scope** (the comment asks for work beyond what this
     issue's spec/plan committed to): **skip it as out-of-scope**, citing
     the spec/plan, and suggest it belongs in a follow-up issue rather
     than silently expanding this PR.
   - **Spec/plan violation** (the comment correctly points out that the
     code deviates from the agreed spec/plan): treat as clearly valid and
     fix, this is exactly the kind of comment to honor.
   - **Bad spec/plan entry** (the comment is valid on its merits but
     reveals that the spec/plan itself was wrong or incomplete): this is a
     judgment call, not a silent fix. **Escalate via `AskUserQuestion`**:
     changing behavior the spec explicitly specified needs your call, and
     the spec/plan may need updating too.
   - **Genuine judgment call** (a design tradeoff, a subjective style
     preference, anything where reasonable people differ): **escalate via
     `AskUserQuestion`** with the reviewer's point and a recommended
     stance; do not decide unilaterally.
3. **Apply the fixes** for the clearly-valid set in one builder
   delegation where practical (batch related changes), handing it the
   comments to address, the diff, and the spec/plan paths. It pushes to
   the PR branch.
4. **Never expand scope** to satisfy a comment: if addressing it correctly
   would exceed the spec/plan, it is the out-of-scope case above, not a
   fix.

## Escalation (the interactive core)

For every judgment call, bad-spec finding, or ambiguous CI fix, use
`AskUserQuestion`: state the reviewer's point (or the ambiguity), what the
spec/plan says, and a recommended option, then act on the answer. Put all
context inside the question and options; do not rely on prose printed
before the call (it can be dropped in a background session). If a question
goes unanswered, do not guess, leave that item unaddressed and report it.

## Replying to reviewers

After pushing fixes:

- **Inline review comments**: reply **per comment**, on that comment's
  own thread (`gh api ... /pulls/comments/<id>/replies` or
  `gh pr review`/`gh api` reply), saying what changed for an addressed one
  or why it was skipped (citing spec/plan for out-of-scope) for a skipped
  one. Do **not** resolve the threads; leave that to the reviewer.
- **General PR comments / review summaries** (not tied to a line): post a
  **single summary PR comment** (`gh pr comment <PR>`) covering the
  non-inline feedback, what was addressed and what was skipped and why.
- Keep replies brief, specific, and respectful. Never dismiss a comment
  without a concrete reason.

## Anti-patterns

- Treating every review comment as an instruction. Judge validity and
  scope against the spec/plan first.
- Silently implementing a comment that exceeds the PR's spec/plan scope,
  or that contradicts what the spec explicitly specified. Escalate or
  skip-with-reason instead.
- "Fixing" an infra/flaky CI failure by changing working code.
- Guessing on a behavior-changing fix or a judgment call. Escalate.
- Resolving review threads on the reviewer's behalf.
- Editing files or pushing yourself instead of delegating code changes to
  the builder (it carries the repo-quality bar and the
  push-to-branch behavior).
- Inventing a spec/plan when none is found; say you are judging on code
  merit alone.
- Thrashing on a check that will not go green; stop after a bounded number
  of attempts and report.

## Done criteria

The branch was brought up to date with its target before diagnosing (or
confirmed already current), so no already-solved failure or comment was
chased; every failing CI check has been either fixed-and-pushed (and
re-checked toward green) or reported as infra/flaky/unresolvable with a
reason; every
review comment has been addressed (fixed + replied), skipped (with a
reasoned reply citing spec/plan where relevant), or escalated to you and
resolved; replies went per-comment on inline threads and as one summary
for general feedback; threads were left unresolved for the reviewer; and
no change exceeded the issue's spec/plan scope without your explicit
approval. If no spec/plan could be found, that limitation was stated up
front.
