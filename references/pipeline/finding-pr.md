# Finding the linked PR

Shared by every pipeline skill. Re-derive the PR fresh whenever you need it (build, QA, merge); never trust a stored `prNumber` over a fresh lookup. Cache it into `state.json.prNumber` after a build, but always re-derive for QA (and merge).

For a **GitHub issue**, the PR is the one GitHub considers linked (its body references it via `Closes #N`):

```
gh repo view --json owner,name --jq '.owner.login + " " + .name'
gh api graphql -f query='query { repository(owner: "OWNER", name: "NAME") { issue(number: <issue>) { closedByPullRequestsReferences(first: 5) { nodes { number } } } } }'
```

Take the first node's number, or none.

For a **local issue** (id starts with `L`), the PR carries no `Closes` link, so find it by the branch the build agent worked on instead (skip this path in a GitHub-only pipeline, which has no local issues):

```
gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --state all --json number --jq '.[0].number'
```

If a phase that needs the PR (build delivery, QA, merge) finds none, fail loudly rather than proceeding.

Merging the finished PR is a separate skill, `/merge-pr <pr>`, which runs its own safety gates (CI green, mergeable, no rule bypass without asking) and marks this issue's `state.json` closed afterward. A pipeline stops at `human-review`; it never merges.
