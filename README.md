# openducktor-agents

Spec, planner, build, and QA subagents modeled on [OpenDucktor](https://github.com/Maxsky5/openducktor)'s agent workflow, adapted to run as Claude Code subagents against a GitHub issue's labels instead of OpenDucktor's own task store.

## What's here

```
agents/                  four Claude Code subagent definitions (plugin-installable)
  spec-agent.md
  planner-agent.md
  build-agent.md
  qa-agent.md
workflows/
  openducktor-issue.js   drives one issue through spec -> plan -> build -> qa
.claude/scripts/
  odt-transition.sh      the only thing allowed to write an issue's status:* label
```

## Two different installation paths

Claude Code plugins can auto-discover an `agents/` directory, but there is no plugin mechanism for Workflow scripts today. That means this repo installs in two different ways depending on the piece:

### The four agents: install once as a plugin

```
/plugin marketplace add ~/Code/openducktor-agents
/plugin install openducktor-agents@openducktor-agents
```

After that, `spec-agent`, `planner-agent`, `build-agent`, and `qa-agent` are available as `subagent_type` in every project, no per-repo copying.

### The workflow and transition script: copy per repo

Copy both files into the repo you want to run this against:

```
mkdir -p <target-repo>/.claude/workflows <target-repo>/.claude/scripts
cp workflows/openducktor-issue.js      <target-repo>/.claude/workflows/
cp .claude/scripts/odt-transition.sh   <target-repo>/.claude/scripts/
chmod +x <target-repo>/.claude/scripts/odt-transition.sh
```

Then in that repo, invoke it explicitly:

```
run the openducktor-issue workflow on issue 142 in auto mode
run the openducktor-issue workflow on issue 142 in manual mode
```

or programmatically: `Workflow({ scriptPath: ".claude/workflows/openducktor-issue.js", args: { issueNumber: 142, mode: "auto" } })`. The `/openducktor-issue 142` slash-command form always runs in auto mode, since a slash command only passes a bare string as `args`.

### Spec and plan live on the issue; build and QA live on the pull request

Spec and plan are posted (and, in manual mode, gated) as tagged comments on the issue, since no pull request exists yet at that point. Build and QA are posted on the pull request instead, which is what QA and any human review actually looks at:

- The build phase's initial completion summary is the pull request's own body/description (`gh pr edit --body`), not a comment, since it's naturally "what this PR does." Every later round on that phase, a QA-rejection fixup or a human `/revise` at the build gate, replies as an ordinary pull request comment instead of re-editing the body.
- The QA phase's report is always a tagged pull request comment, revised in place on a human `/revise`, the same way spec/plan comments are.

The workflow has no memory of the pull request number across runs. Every read against the pull request (comments, gate directives, the QA verdict) re-derives it via `findLinkedPr()`, a GraphQL lookup of the PR(s) GitHub already considers linked to the issue (the same mechanism that resolves `Closes #N`), rather than trusting a number an earlier run happened to learn.

### Auto mode versus manual mode

**Auto mode** runs straight through: each phase's agent posts its artifact, the transition script immediately advances the label, and the next phase starts in the same invocation, ending at a QA verdict.

**Manual mode** stops after every phase. The phase's artifact is posted (a tagged issue comment for spec/plan, the pull request body for build's first pass, a tagged pull request comment for QA), and the issue is set to a `status:<phase>-awaiting-approval` gate label. The run ends there. A human reviews the artifact where it was posted and comments:

- `/approve`, to advance past the gate. Re-running the workflow (same issue, same or no mode argument) picks this up, performs the real transition, and continues into the next phase, which stops at its own gate in turn.
- `/revise <feedback>`, to send that feedback back into the same phase's agent. Spec and plan edit the existing tagged comment in place and fold a brief note of what changed into the top of that same comment; they never post a second comment. QA edits its report comment in place and posts a separate short reply summarizing what changed. Build replies with a pull request comment instead of editing the body, and does not post a second completion summary. The issue stays at the same gate, awaiting another `/approve` or `/revise`.

Re-running the workflow with no `/approve` or `/revise` comment since the gate was set is always safe: it reports "waiting for review" and exits without touching anything.

Every posted or revised comment mentions `@Felixmil` (configurable via `NOTIFY_GITHUB_USERNAME` at the top of the script) so GitHub sends a notification regardless of the repo's default notification settings.

### merge mode

`/openducktor-issue 142 merge` is a standalone terminal action, not a pipeline phase. It refuses to run unless the issue is currently at `status:human-review`, since that status exists specifically as the one point a human is meant to look at the result before it lands; neither auto nor manual mode ever calls it automatically. Once at that gate, it squash-merges the linked pull request (`gh pr merge --squash --delete-branch`), then transitions the issue to `status:closed`.

### QA rejection loops back into build

A `QA-VERDICT: rejected` report is fed back to the build agent as fix-it feedback, not left for a human to relay by hand:

- **Auto mode**: rejection re-invokes the build agent with the QA report, then re-runs QA, up to `MAX_QA_ROUNDS` (default 3) total build attempts in the same run. Still rejected after the cap, the issue is left at `status:in-progress` for a human.
- **Manual mode**: at the `status:qa-awaiting-approval` gate, `/revise <feedback>` sends the QA report plus that feedback to the build agent (not back to the QA agent), then automatically re-runs QA and re-posts at the same gate. `/approve` at that gate still reads whichever verdict is currently posted and transitions accordingly.

### A real design ambiguity forces a gate even in auto mode

`spec-agent` and `planner-agent` are both told to record a genuine, materially scope-changing ambiguity as a `[NEEDS CLARIFICATION]` marker with a recommended default, instead of silently guessing. Auto mode would otherwise adopt that default and move straight to the next phase without anyone seeing the question.

Instead, after posting a spec or plan, the workflow re-fetches the actual comment and checks it for that marker. If present, it forces the same `status:<phase>-awaiting-approval` gate manual mode uses, regardless of which mode the run was invoked with, and logs the open question. `/approve` accepts the recommended default and continues; `/revise <feedback>` resolves it differently.

The check requires the marker to start a line (`hasOpenClarificationMarker()`), not a bare substring match. A plan that closes with "No open [NEEDS CLARIFICATION] items" is stating the negation, not raising one, and a substring check would have gated on that sentence just as readily as a genuine open question. Both prompts are also told to never write the literal string except as a real, line-starting marker, and to omit it entirely rather than write about its absence.

A calling agent that already relayed the question to a human and got an answer does not need to post a `/revise` comment and re-invoke by hand: pass `args.clarificationAnswer` directly (`Workflow({ ..., args: { issueNumber, clarificationAnswer: "..." } })`). The workflow re-runs that phase's own agent with the answer, edits the existing artifact in place, and, once the marker is gone, continues straight into the rest of the pipeline in the same invocation instead of stopping again just to be approved.

`parseArgs()` also accepts that same object JSON-stringified (some resume/relaunch paths re-serialize `args` to a string before the script sees it): a string starting with `{` is parsed back into an object before being read, rather than falling through to the slash-command tokenizer and mangling the object into garbage tokens.

Build and QA have no equivalent marker or gate. `build-agent`'s prompt says to stop and post a plain comment explaining a scope-exceeding blocker instead of expanding scope silently, but the workflow script does not currently detect that comment or react to it differently from a normal completion summary; a scope blocker raised mid-build will not stop the pipeline the way `[NEEDS CLARIFICATION]` now stops spec/plan.

### Mechanical steps run on a cheaper model

`spec-agent`, `planner-agent`, `build-agent`, and `qa-agent` have no `model:` in their frontmatter, so they inherit whichever model the workflow itself is running under (Opus, Sonnet, whatever the invoking session resolved to). That's deliberate: these four do the actual reasoning, writing, and reviewing, and are the last place to cut model tier.

The workflow script's own bookkeeping calls, reading the current label, running a label transition, and reading comments since a tagged artifact, do none of that. They just run one `gh`/`bash` command and relay or validate a small structured result, and each run fires several of them (every phase transition, every label read, every gate check). Those four call sites (`transitionTo`, `currentLabel`'s read and its `status:open` bootstrap write, `commentsSinceTag`) pass `model: "haiku"` explicitly. `currentLabel` and `commentsSinceTag` also pass a `schema`, forcing a small structured object instead of prose; without that, either one narrating an empty result in plain English (e.g. "the command completed with no output") gets mistaken for real content and can silently stall the pipeline, a risk a schema removes structurally rather than one a bigger model happens to avoid by being less chatty.

Spec and plan revisions (`/revise <feedback>` or a resolved `[NEEDS CLARIFICATION]` answer at their gates) also pass `model: "sonnet"`: reading feedback and editing existing markdown in place is a simpler task than the from-scratch reasoning the main spec/plan phases do. Build revisions are excluded from this, `revise()` for the build phase still writes real code changes and runs on whatever model the session resolved to, same as the main build phase. QA never reaches `revise()` at all: a QA-gate `/revise` routes to the build agent instead (see above).

### Agent type names are plugin-prefixed

Once installed via a plugin, the four agents are not registered as `spec-agent`, `planner-agent`, `build-agent`, `qa-agent`. They're namespaced as `openducktor-agents:spec-agent`, `openducktor-agents:planner-agent`, `openducktor-agents:build-agent`, `openducktor-agents:qa-agent`, to avoid colliding with same-named agents from other plugins or from a project's own `.claude/agents/`. `workflows/openducktor-issue.js` already uses the prefixed names. If you write your own workflow or call these agents directly, use the prefixed form; the bare name will fail with an "agent type not found" error listing the actual registered names.

## The state machine

`.claude/scripts/odt-transition.sh` enforces the same transition table as OpenDucktor's `status-transition-policy.ts`:

```
status:open -> status:spec-ready -> status:ready-for-dev -> status:in-progress
  -> status:ai-review -> status:human-review -> status:closed
```

Task and bug issues (label `type:task` or `type:bug`) may skip straight from `status:open` to `status:in-progress`.

No agent in `agents/` is given `gh issue edit --add-label`. Only `odt-transition.sh` writes label *transitions*, and it refuses any transition not in the table above. This is deliberate: the model that can be talked into anything should never hold the pen that moves the state machine.

The one exception is bootstrapping: a freshly filed issue has no `status:*` label at all, which is not a transition (there is no "from" state), so `workflows/openducktor-issue.js` seeds `status:open` directly via `gh issue edit --add-label` the first time it sees such an issue, then proceeds normally through `odt-transition.sh` from there.

Manual mode adds four gate labels to the same table, one per phase: `status:spec-awaiting-approval`, `status:plan-awaiting-approval`, `status:build-awaiting-approval`, `status:qa-awaiting-approval`. Each is entered from the status that precedes its phase and exits, on `/approve`, to the exact real status that phase would have produced in auto mode. Auto mode never touches these labels.

## Target repo prerequisites

- `gh` CLI authenticated against the repo.
- Labels created: `status:open`, `status:spec-ready`, `status:ready-for-dev`, `status:in-progress`, `status:blocked`, `status:ai-review`, `status:human-review`, `status:closed`, plus `type:task` / `type:bug` / `type:feature` / `type:epic` if you want the skip-spec shortcut to apply.
- For manual mode: also create `status:spec-awaiting-approval`, `status:plan-awaiting-approval`, `status:build-awaiting-approval`, `status:qa-awaiting-approval`.

## Known gaps versus OpenDucktor

- No worktree isolation between build and QA by default. Pass `isolation: "worktree"` to the build-agent call in the workflow script if agents run concurrently and might collide.
- The QA verdict is a `QA-VERDICT: approved|rejected` string convention read out of the agent's final text, not a typed tool call. Passing a `schema` to that `agent()` call would remove the string-matching risk.
- No cross-task or cross-issue coherence check. Each issue is planned and built independently; nothing here detects two issues whose specs contradict each other. Neither does OpenDucktor's own state machine, beyond blocking an epic from closing while a subtask is still open.
- No canonical task-summary object. Every agent re-reads the full issue thread (or, for build/QA, the pull request thread) via `gh issue view --comments` / `gh pr view --json comments` instead of a cached document-presence summary.
