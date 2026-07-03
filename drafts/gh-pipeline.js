// DRAFT / INACTIVE. This file lives under drafts/ and is not part of the
// plugin's discovered workflows/ directory; nothing invokes it. The
// gh-posting pipeline was converted to an in-session skill
// (skills/run-pipeline-gh/), the same way the file-based pipeline is the
// run-pipeline skill. This dynamic-workflow version was deactivated (not
// deleted). Its label mutator, .claude/scripts/status-transition.sh, is
// still ACTIVE because the run-pipeline-gh skill uses it. See
// drafts/README.md for the reactivation steps.
//
// Copy this file into a target repo's .claude/workflows/ directory
// (plugins cannot distribute Workflow scripts today; only agents/
// are plugin-discoverable). Requires .claude/scripts/status-transition.sh to
// also be copied into that repo's scripts/ directory, and the four
// agents from this plugin to be installed.
//
// Run with:
//   Workflow({ scriptPath: ".claude/workflows/gh-pipeline.js", args: { issueNumber: 142, mode: "auto" } })
//   Workflow({ scriptPath: ".claude/workflows/gh-pipeline.js", args: { issueNumber: 142, mode: "manual" } })
//   Workflow({ scriptPath: ".claude/workflows/gh-pipeline.js", args: { issueNumber: 142, mode: "merge" } })
// or as a slash command: /gh-pipeline 142 (auto mode)
//                     or: /gh-pipeline 142 manual (manual mode)
//                     or: /gh-pipeline 142 merge (merge mode)
//
// This is the gh-posting variant of the pipeline. State lives in the
// issue's status:* labels; the four artifacts are POSTED to GitHub
// (spec/plan as tagged issue comments, build as the PR body/comment, QA
// as a tagged PR comment). The heavy per-phase work is done by four
// file-writing agents (dev-crew:spec-writer / planner / builder /
// reviewer) that only write a local artifact file under
// <repo>.issues/<issue>/ and return a structured result; this workflow
// then reads that file and posts it. The agents never post to GitHub
// themselves (only the builder touches the PR, to open/update it);
// posting is this workflow's job.
//
// auto mode: every phase's output is immediately approved and the
// pipeline runs straight through to a QA verdict in one invocation.
//
// manual mode: each phase stops at a status:<phase>-awaiting-approval
// gate after posting its artifact, and the run ends. Spec and plan
// post to the issue (tagged comments); build and QA post to the
// linked pull request instead (build's initial artifact is the PR's
// own body, QA's is a tagged PR comment), since that is what QA and
// any human review actually looks at. A human reviews the artifact
// where it was posted and comments either:
//   /approve                 -> advance to the next real status and
//                               continue into the next phase (which
//                               will stop at its own gate in turn)
//   /revise <feedback text>  -> re-run the same phase's agent with
//                               that feedback (the agent re-writes its
//                               local artifact file), then the
//                               workflow edits the existing artifact in
//                               place (or replies as a comment, for
//                               build) and replies to the /revise
//                               comment, then stays at the same gate
// Re-running this script with the same issue number and mode: manual
// is always safe. If no /approve or /revise comment has been posted
// since the gate was set, it reports "waiting" and exits without
// doing anything.
//
// A caller sitting at a spec or plan clarification gate (see below)
// can instead pass args.clarificationAnswer directly, e.g.
//   Workflow({ scriptPath: "...", args: { issueNumber: 142, clarificationAnswer: "..." } })
// This re-runs that phase's own agent with the answer and, once the
// agent returns a clean "done" (no further clarification needed),
// continues straight into the rest of the pipeline in the same
// invocation, rather than requiring a /revise comment posted by hand
// followed by a second run.
//
// merge mode is a standalone terminal action, not a pipeline phase.
// It only runs when explicitly invoked (never automatically from auto
// or manual mode), and only when the issue is at status:human-review,
// the one point a human is meant to look at the result before it
// lands. It squash-merges the linked pull request, deletes its
// branch, and transitions the issue to status:closed.

export const meta = {
  name: "gh-pipeline",
  description:
    "Drive one GitHub issue through spec -> plan -> build -> qa, auto or gated on human approval",
  phases: [{ title: "Spec" }, { title: "Plan" }, { title: "Build" }, { title: "QA" }],
};

// GitHub notifies the issue author on any comment automatically, but
// an explicit @-mention is the reliable trigger regardless of that
// setting. Set this to the GitHub username who should be pinged when
// an artifact is posted or revised. Leave "" to disable mentioning.
const NOTIFY_GITHUB_USERNAME = "Felixmil";

const mention = () => (NOTIFY_GITHUB_USERNAME ? `@${NOTIFY_GITHUB_USERNAME} ` : "");

// In auto mode, a QA rejection sends the issue straight back to
// build, up to this many build -> QA rounds, before giving up and
// leaving it at status:in-progress for a human to look at.
const MAX_QA_ROUNDS = 3;

// The structured return the four file-writing agents produce (see
// agents/spec-writer.md, planner.md, builder.md, reviewer.md). Every
// phase agent is called with this schema: it writes its artifact file
// and returns {"status":"done"} or, when a genuine ambiguity needs a
// human, {"status":"clarification-needed", question, options,
// recommendedDefault}. The reviewer only ever returns {"status":"done"}
// (its verdict lives on the last line of qa.md), but sharing one schema
// is harmless.
const AGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["done", "clarification-needed"] },
    question: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "description"],
        properties: { label: { type: "string" }, description: { type: "string" } },
      },
    },
    recommendedDefault: { type: "string" },
  },
};

const PHASE_DEFS = [
  {
    key: "spec",
    label: "Spec",
    tag: "<!-- gh-pipeline:spec -->",
    artifact: "spec.md",
    // No PR exists yet at this point; spec and plan live on the issue.
    commentTarget: "issue",
    fromStatus: ["status:open"],
    gateLabel: "status:spec-awaiting-approval",
    toStatus: "status:spec-ready",
    agentType: "dev-crew:spec-writer",
  },
  {
    key: "plan",
    label: "Plan",
    tag: "<!-- gh-pipeline:plan -->",
    artifact: "plan.md",
    commentTarget: "issue",
    fromStatus: ["status:spec-ready"],
    gateLabel: "status:plan-awaiting-approval",
    toStatus: "status:ready-for-dev",
    agentType: "dev-crew:planner",
  },
  {
    key: "build",
    label: "Build",
    tag: "<!-- gh-pipeline:build -->",
    artifact: "build.md",
    // The pull request this phase creates is what QA and any human
    // review actually looks at. The builder agent opens/updates the
    // real PR with a clean "Closes #N" body of its own; the workflow
    // then overlays the fuller build.md as the PR body/description on
    // the first pass, since that is naturally "what this PR does."
    // Every later round (a QA rejection fixup, or a human /revise at
    // the build gate) replies as an ordinary PR comment instead of
    // re-editing the body. The PR number is re-derived per run via
    // findLinkedPr(), never carried across runs.
    commentTarget: "pr",
    initialArtifactIsPrBody: true,
    // ready-for-dev is the normal entry; a task/bug issue that skips
    // spec/plan starts at open -> in-progress directly (see the
    // README's skip-planning note), and a previously blocked build
    // resumes from blocked. All three enter the same start transition.
    fromStatus: ["status:ready-for-dev", "status:in-progress", "status:blocked"],
    // The transition table has no ready-for-dev -> ai-review edge:
    // starting work is its own transition (ready-for-dev/blocked ->
    // in-progress), matching OpenDucktor's odt_build_resumed/
    // odt_build_completed split. startStatus is applied before the
    // agent runs (postArtifact), and skipped when the issue is
    // already at in-progress (the table has no in-progress ->
    // in-progress edge). toStatus (in-progress -> ai-review) is then
    // applied after the build agent completes.
    startStatus: "status:in-progress",
    gateLabel: "status:build-awaiting-approval",
    toStatus: "status:ai-review",
    agentType: "dev-crew:builder",
  },
  {
    key: "qa",
    label: "QA",
    tag: "<!-- gh-pipeline:qa -->",
    artifact: "qa.md",
    commentTarget: "pr",
    fromStatus: ["status:ai-review"],
    gateLabel: "status:qa-awaiting-approval",
    // No single toStatus: the QA verdict decides human-review vs in-progress.
    agentType: "dev-crew:reviewer",
  },
];

async function transitionTo(issue, to) {
  await agent(`Run: bash .claude/scripts/status-transition.sh ${issue} ${to}`, {
    label: "transition",
    model: "haiku",
  });
}

// A freshly filed issue has no status:* label yet. Treat that as
// status:open and apply the label, so the issue's actual state
// matches what this workflow believes from here on, rather than
// silently diverging the way a missing status:closed label did.
//
// The gh command legitimately produces no stdout when the issue has
// no status:* label. A plain-text agent call asked to "return only
// that label string" can narrate the empty result instead ("the
// command completed with no output") rather than return an empty
// string, and that prose would otherwise be mistaken for a real
// label and silently stall the whole workflow. Forcing a schema and
// then extracting a genuine status:* token defensively (instead of
// trusting the field verbatim) closes that gap structurally.
async function currentLabel(issue) {
  const out = await agent(
    `Run: gh issue view ${issue} --json labels --jq '.labels[].name | select(startswith("status:"))'. ` +
      `Set statusLabel to the exact status:* label from stdout, or "" if stdout was empty.`,
    {
      label: "read-label",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["statusLabel"],
        properties: {
          statusLabel: {
            type: "string",
            description: 'The status:* label, e.g. "status:open", or "" if there is none.',
          },
        },
      },
    },
  );
  const match = String(out?.statusLabel ?? "").match(/status:[A-Za-z0-9._-]+/);
  if (match) {
    return match[0];
  }
  await agent(`Run: gh issue edit ${issue} --add-label status:open`, {
    label: "seed-open-label",
    model: "haiku",
  });
  return "status:open";
}

// The per-issue scratch directory where the file-writing agents drop
// their artifacts (spec.md/plan.md/build.md/qa.md). It lives in a
// sibling of the checkout named <repo>.issues so all worktrees of one
// repo share one root, and is created on demand. The files are the
// agents' output channel; this workflow reads them and posts their
// contents to GitHub. Returns an absolute path.
async function scratchDir(issue) {
  const out = await agent(
    `Run: git rev-parse --git-common-dir. That prints a path ending in "/.git" (or ".git"); resolve it to ` +
      `an absolute path, take its parent directory as the repo root, and set parentDir to that directory's ` +
      `parent and repoName to that directory's basename (both absolute). Then run: ` +
      `mkdir -p "$parentDir/$repoName.issues/${issue}" to ensure the scratch dir exists.`,
    {
      label: "scratch-dir",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["parentDir", "repoName"],
        properties: {
          parentDir: { type: "string", description: "Absolute path to the directory containing the repo root." },
          repoName: { type: "string", description: "Basename of the repo root directory." },
        },
      },
    },
  );
  return `${out.parentDir}/${out.repoName}.issues/${issue}`;
}

// The absolute path to a phase artifact file. This is the file the
// phase agent writes and this workflow posts from; passing the path (not
// the content) to the posting helpers keeps the artifact off the token
// path (see composeAndRun).
function artifactPath(dir, def) {
  return `${dir}/${def.artifact}`;
}

// Assert a phase artifact exists and is non-empty, throwing if not,
// since an agent that returned "done" must have written it. Used before
// posting from the path, where the file itself never crosses the token
// boundary.
async function requireArtifact(dir, artifact) {
  const out = await agent(
    `Run under bash: test -s ${dir}/${artifact} && echo PRESENT || echo MISSING. Set present=true only if ` +
      `stdout was PRESENT.`,
    {
      label: "require-artifact",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["present"],
        properties: { present: { type: "boolean" } },
      },
    },
  );
  if (!out?.present) {
    throw new Error(`Phase artifact ${dir}/${artifact} is missing or empty after the agent returned done.`);
  }
}

// Read one artifact file's full contents. Only used where the workflow
// itself needs the text (parsing the QA verdict, feeding the QA report
// into the build fixup prompt), never merely to re-post it. Posting is
// done from the path via composeAndRun so the artifact stays on disk.
async function readArtifact(dir, artifact) {
  const out = await agent(
    `Run: cat ${dir}/${artifact}. Set present=false if the file does not exist or is empty; otherwise set ` +
      `present=true and content to the file's full contents verbatim.`,
    {
      label: "read-artifact",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["present"],
        properties: { present: { type: "boolean" }, content: { type: "string" } },
      },
    },
  );
  if (!out?.present || typeof out.content !== "string") {
    throw new Error(`Phase artifact ${dir}/${artifact} is missing or empty after the agent returned done.`);
  }
  return out.content;
}

// The pull request GitHub considers linked to this issue (the PR
// whose body references it, e.g. via "Closes #N"), or null if none
// exists yet. Re-derived on every call rather than carried across
// workflow runs, since a fresh invocation has no memory of a PR
// number a prior run may have learned.
async function findLinkedPr(issue) {
  const out = await agent(
    `Run: gh repo view --json owner,name --jq '.owner.login + " " + .name'. Then run exactly: ` +
      `gh api graphql -f query='query { repository(owner: "OWNER", name: "NAME") { issue(number: ${issue}) { ` +
      `closedByPullRequestsReferences(first: 5) { nodes { number } } } } }' with OWNER and NAME substituted ` +
      `from the first command. Set prNumber to the first node's number, or null if there are none.`,
    {
      label: "find-linked-pr",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["prNumber"],
        properties: {
          prNumber: { type: ["integer", "null"], description: "The linked PR number, or null if none." },
        },
      },
    },
  );
  return typeof out?.prNumber === "number" ? out.prNumber : null;
}

// `gh` invocation fragment for reading comments: the issue itself for
// commentTarget "issue", or the linked PR for commentTarget "pr". Both
// expose the same --json comments shape.
async function commentSource(issue, def) {
  if (def.commentTarget !== "pr") {
    return { target: `issue view ${issue}`, ok: true };
  }
  const pr = await findLinkedPr(issue);
  return pr ? { target: `pr view ${pr}`, ok: true } : { target: null, ok: false };
}

// Every comment at def's comment target that comes after the one
// tagged with `tag`, oldest first, as an array of { body } objects.
// If the tag is not found (including when the target has no comments
// yet, or commentTarget is "pr" and no PR exists yet), returns every
// comment at that target, which is also the correct behavior for the
// build phase: its initial artifact is the PR body, not a comment,
// so there is nothing to scan past.
async function commentsSinceTag(issue, def) {
  const source = await commentSource(issue, def);
  if (!source.ok) {
    return [];
  }
  const jq =
    `.comments as $c | ($c | to_entries | map(select(.value.body | contains("${def.tag}"))) | ` +
    `if length == 0 then -1 else .[-1].key end) as $i | ` +
    `[$c[($i + 1):][] | {body: .body}]`;
  // Same structural risk as currentLabel(): an unconstrained agent
  // narrating an empty or malformed result instead of echoing raw
  // JSON would silently degrade to "no directive yet" today, which
  // happens to be a safe direction to fail in, but a schema removes
  // the ambiguity rather than relying on that being safe by luck.
  const out = await agent(
    `Run exactly: gh ${source.target} --json comments --jq '${jq}'. Set comments to the parsed JSON array from stdout, or [] if stdout was empty.`,
    {
      label: "read-comments-since-tag",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["comments"],
        properties: {
          comments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["body"],
              properties: { body: { type: "string" } },
            },
          },
        },
      },
    },
  );
  return Array.isArray(out?.comments) ? out.comments : [];
}

// Render a "[NEEDS CLARIFICATION]" block from an agent's structured
// clarification-needed return, for human visibility inside the posted
// spec/plan comment. The marker text is unchanged from the old
// behavior (a "[NEEDS CLARIFICATION] <question>" line starting a
// line), but it now comes from the structured return, not from
// scanning the agent's file. The recommended default is listed first
// among the options, matching the agents' contract.
function renderClarificationBlock(result) {
  const lines = [`[NEEDS CLARIFICATION] ${result.question}`];
  const options = Array.isArray(result.options) ? result.options : [];
  if (options.length > 0) {
    lines.push("", "Options:");
    options.forEach((opt, i) => {
      const isDefault = opt.label === result.recommendedDefault;
      lines.push(`${i + 1}. ${opt.label}${isDefault ? " (recommended default)" : ""}: ${opt.description}`);
    });
    lines.push(
      "",
      `Comment /approve to accept the recommended default (${result.recommendedDefault}), ` +
        `or /revise <feedback> to resolve it differently.`,
    );
  }
  return lines.join("\n");
}

// Post def's artifact to its comment target as a NEW tagged comment
// (or, for build's initial PR-body artifact, set the PR body). The tag
// line and the @-mention are folded in here by the workflow; the agent
// no longer posts anything. The artifact stays on disk: only the small
// prefix crosses the token boundary, and the shell prepends it to the
// artifact file before posting. `artifact` may be null (e.g. when the
// only content is a rendered clarification question and no file exists).
async function postTaggedComment(issue, def, artifact, { clarification } = {}) {
  const clarifBlock = clarification ? `${renderClarificationBlock(clarification)}\n\n` : "";
  const prefix = `${def.tag}\n${mention()}\n\n${clarifBlock}`;
  if (def.initialArtifactIsPrBody) {
    const pr = await findLinkedPr(issue);
    if (!pr) {
      throw new Error(`Build agent returned done but no linked pull request was found to set the body on.`);
    }
    await composeAndRun(prefix, artifact, (path) => `gh pr edit ${pr} --body-file ${path}`, "set-pr-body");
    return;
  }
  await composeAndRun(prefix, artifact, (path) => `gh issue comment ${issue} --body-file ${path}`, "post-comment");
}

// Edit def's existing tagged comment in place with the fresh artifact,
// folding a brief "what changed" note in at the top. Used on a
// spec/plan /revise or clarificationAnswer round. Finds the comment id
// of the last comment carrying def.tag, then edits it via the API. Only
// ever called for spec/plan, whose comments live on the issue (the REST
// issues/comments endpoint), so that endpoint is always correct here.
async function editTaggedComment(issue, def, artifact, whatChanged, { clarification } = {}) {
  const source = await commentSource(issue, def);
  if (!source.ok) {
    throw new Error(`Cannot edit ${def.key} comment: no comment target found.`);
  }
  const noteBlock = whatChanged ? `_What changed: ${whatChanged}_\n\n` : "";
  const clarifBlock = clarification ? `${renderClarificationBlock(clarification)}\n\n` : "";
  const prefix = `${def.tag}\n${mention()}\n\n${noteBlock}${clarifBlock}`;
  const jq = `[.comments[] | select(.body | contains("${def.tag}"))] | last | .url`;
  await composeAndRun(
    prefix,
    artifact,
    (path) =>
      `url=$(gh ${source.target} --json comments --jq '${jq}') && ` +
      `id=$(printf '%s' "$url" | grep -oE '[0-9]+$') && ` +
      `gh api --method PATCH "repos/{owner}/{repo}/issues/comments/$id" -F body=@${path} > /dev/null`,
    "edit-comment",
  );
}

// Post the given artifact as an ordinary (untagged) PR comment. Used
// for build's later rounds (a QA fixup or a human /revise at the build
// gate), which reply as a comment rather than re-editing the PR body.
async function postPrComment(issue, artifact) {
  const pr = await findLinkedPr(issue);
  if (!pr) {
    throw new Error(`No linked pull request found to post the build round comment on.`);
  }
  await composeAndRun(`${mention()}\n\n`, artifact, (path) => `gh pr comment ${pr} --body-file ${path}`, "pr-comment");
}

// Post a short reply comment at def's comment target acknowledging a
// human directive (a /revise or /approve action), so the thread shows
// the workflow responded. Untagged, no artifact; it is not an artifact.
async function postReply(issue, def, text) {
  if (def.commentTarget === "pr") {
    const pr = await findLinkedPr(issue);
    if (!pr) {
      return;
    }
    await composeAndRun(`${mention()}${text}`, null, (path) => `gh pr comment ${pr} --body-file ${path}`, "reply-comment");
    return;
  }
  await composeAndRun(`${mention()}${text}`, null, (path) => `gh issue comment ${issue} --body-file ${path}`, "reply-comment");
}

// Assemble the posted body on disk and run the given gh command against
// it via --body-file. The `prefix` (the small, workflow-composed header:
// tag line, @-mention, any "what changed" note or clarification block)
// is written with a quoted heredoc (no expansion); the artifact file, if
// any, is then appended verbatim with `cat`. This keeps the (possibly
// large) artifact entirely on disk instead of round-tripping it through
// the agent's prompt and output, and posting via --body-file (not an
// inlined --body) avoids any shell-quoting corruption of multi-line
// markdown. The temp body file is removed afterward; a non-zero exit is
// surfaced.
async function composeAndRun(prefix, artifactPath, cmd, label) {
  const bodyPath = `/tmp/gh-pipeline-${label}-$$.md`;
  const appendArtifact = artifactPath ? `cat ${artifactPath} >> ${bodyPath}\n` : "";
  const out = await agent(
    `Run these commands exactly, in order, under bash. Do not substitute, reformat, or invent any other ` +
      `command; if any exits non-zero, STOP, set ok=false, and put the failing command's stderr in error.\n\n` +
      `1. Write the header prefix to a temp body file with a quoted heredoc (no expansion):\n` +
      `cat > ${bodyPath} <<'GHPIPELINE_EOF'\n${prefix}\nGHPIPELINE_EOF\n\n` +
      (appendArtifact ? `2. Append the artifact file verbatim:\n${appendArtifact}\n3. ${cmd(bodyPath)}\n\n4. rm -f ${bodyPath}\n\n` : `2. ${cmd(bodyPath)}\n\n3. rm -f ${bodyPath}\n\n`) +
      `Set ok=true only if every command except the final rm exited 0.`,
    {
      label,
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" }, error: { type: "string" } },
      },
    },
  );
  if (!out?.ok) {
    throw new Error(`${label} failed: ${out?.error ?? "unknown error"}`);
  }
}

function latestDirective(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = (comments[i].body ?? "").trim();
    if (body.startsWith("/approve")) {
      return { kind: "approve" };
    }
    if (body.startsWith("/revise")) {
      return { kind: "revise", feedback: body.slice("/revise".length).trim() };
    }
  }
  return null;
}

// ---- phase agent invocation ----
//
// Every phase agent writes its artifact to the scratch file and returns
// the AGENT_SCHEMA object. It never posts to GitHub (only the builder
// touches the PR, to open/update it); the workflow reads the file and
// posts it.

// The read-only upstream artifact paths handed to a phase agent.
function readOnlyPaths(dir, key) {
  const upstream = { plan: ["spec.md"], build: ["spec.md", "plan.md"], qa: ["spec.md", "plan.md"] };
  return (upstream[key] ?? []).map((f) => `${dir}/${f}`);
}

// Run a phase's file-writing agent for its first attempt on this
// status. Returns the agent's structured object.
async function runPhaseAgent(issue, dir, def, { auto }) {
  const artifactPath = `${dir}/${def.artifact}`;
  const reads = readOnlyPaths(dir, def.key);
  const readsLine = reads.length ? ` Read-only context paths: ${reads.join(", ")}.` : "";
  const autoLine = auto
    ? ` You are in auto mode: never raise a question. On any ambiguity adopt your own recommended default, ` +
      `record that decision in the artifact, and return {"status":"done"}.`
    : "";

  let task;
  if (def.key === "spec") {
    task = `Read GitHub issue ${issue} and write its specification to the exact path ${artifactPath}.`;
  } else if (def.key === "plan") {
    task = `Read this issue's spec at ${dir}/spec.md and write the implementation plan for GitHub issue ${issue} to ${artifactPath}.`;
  } else if (def.key === "build") {
    task =
      `Implement GitHub issue ${issue} per its spec (${dir}/spec.md) and plan (${dir}/plan.md). Open or update ` +
      `the pull request with a clean, repo-facing body containing "Closes #${issue}". Then write the fuller ` +
      `build summary to ${artifactPath}. Do not post any issue or pull request comment.`;
  } else {
    task =
      `Review the pull request for GitHub issue ${issue} against ${dir}/spec.md and ${dir}/plan.md, and write ` +
      `the QA report to ${artifactPath} ending in exactly one "QA-VERDICT: approved" or "QA-VERDICT: rejected" ` +
      `line. Do not post any issue or pull request comment.`;
  }

  return await agent(`${task}${readsLine}${autoLine}`, {
    agentType: def.agentType,
    phase: def.label,
    schema: AGENT_SCHEMA,
  });
}

// Re-run a spec/plan agent to fold in a human's /revise feedback or a
// clarification answer; the agent re-writes its artifact file in place.
// Editorial, so it runs on the cheaper model. `answer` is a
// clarification answer (folded in as a locked decision) when
// isClarificationAnswer, otherwise it is /revise feedback. Returns the
// agent's structured object.
async function reviseArtifact(issue, dir, def, feedback, { isClarificationAnswer = false } = {}) {
  const artifactPath = `${dir}/${def.artifact}`;
  const intro = isClarificationAnswer
    ? `A human answered your open clarification question: "${feedback}". Fold it in as a locked decision, do ` +
      `not re-ask it, and re-write the ${def.key} artifact in place at ${artifactPath}.`
    : `A human requested changes to the ${def.key}: "${feedback}". Re-write the ${def.key} artifact in place ` +
      `at ${artifactPath} with the changes folded in.`;
  return await agent(`For GitHub issue ${issue}, ${intro}`, {
    agentType: def.agentType,
    phase: "Revise",
    model: "sonnet",
    schema: AGENT_SCHEMA,
  });
}

// Route a QA-rejection (or a QA-gate revise) back to the build agent as
// fixup feedback: QA's reasoning belongs in the code, not re-reviewed.
// The build agent updates the PR branch and re-writes build.md; the
// workflow then posts build.md as a PR comment for the round. Returns
// the agent's structured object.
async function fixupBuild(issue, dir, buildDef, qaReport, feedback) {
  const extra = feedback ? ` Additional human feedback: ${feedback}` : "";
  return await agent(
    `Read GitHub issue ${issue}. The QA agent reviewed the pull request and rejected it with this report:\n\n` +
      `${qaReport}\n\n` +
      `Address every finding at its root cause against ${dir}/spec.md and ${dir}/plan.md, push to the same ` +
      `pull request branch, rerun relevant verification, and update ${dir}/${buildDef.artifact}. Do not post ` +
      `any pull request comment.${extra}`,
    { agentType: buildDef.agentType, phase: "Build", schema: AGENT_SCHEMA },
  );
}

// ---- per-phase posting drivers ----

// Run the spec/plan agent, then post its artifact to the issue as a
// tagged comment. Applies build's own start transition before running.
// Returns the agent's structured object so the caller can gate on a
// clarification-needed return.
async function postArtifact(issue, dir, def, currentStatus, { auto }) {
  if (def.startStatus && currentStatus !== def.startStatus) {
    await transitionTo(issue, def.startStatus);
  }
  const result = await runPhaseAgent(issue, dir, def, { auto });
  if (result.status === "clarification-needed") {
    // The agent wrote no artifact file in this case (per its contract);
    // post the rendered question as the tagged comment so a human sees
    // it, and let the caller force the gate.
    await postTaggedComment(issue, def, null, { clarification: result });
    return result;
  }
  // Spec/plan post their artifact as a tagged issue comment; build's
  // initial artifact overlays build.md onto the PR body/description
  // (the builder already opened the PR with a clean "Closes #N" body).
  // postTaggedComment routes on def.initialArtifactIsPrBody, and posts
  // from the on-disk artifact path.
  await requireArtifact(dir, def.artifact);
  await postTaggedComment(issue, def, artifactPath(dir, def));
  return result;
}

// Run the QA agent, read the verdict off the last QA-VERDICT: line of
// qa.md (never from agent prose), and post qa.md as a tagged PR comment.
// Returns { verdict, report }.
async function postQaArtifact(issue, dir, def) {
  await runPhaseAgent(issue, dir, def, { auto: false });
  // QA is the one artifact whose text the workflow itself needs (to
  // parse the verdict off the last QA-VERDICT: line, and to feed the
  // report into a build fixup on rejection), so read its content here.
  // It is still posted from the on-disk path, not the read content.
  const report = await readArtifact(dir, def.artifact);
  const verdict = parseVerdict(report);
  await postTaggedComment(issue, def, artifactPath(dir, def));
  return { verdict, report };
}

// The last "QA-VERDICT: <word>" line in the report decides the verdict.
// Parsed from the file text, not from any agent summary.
function parseVerdict(report) {
  const matches = String(report).match(/QA-VERDICT:\s*(approved|rejected)/gi) ?? [];
  const last = matches[matches.length - 1] ?? "";
  return /approved/i.test(last) ? "approved" : "rejected";
}

// args arrives as one of:
//   { issueNumber: 142, mode: "auto" | "manual", clarificationAnswer?: "..." }
//                                                    (programmatic Workflow() call)
//   '{"issueNumber": 142, ...}'                       (the object form, but
//                                                       re-serialized to a JSON
//                                                       string by some resume/
//                                                       relaunch paths)
//   142                                              (bare number)
//   "142"                                            (slash command, no mode word)
//   "142 manual"                                     (slash command, with a mode word)
// clarificationAnswer only comes through the object form; there is no
// slash-command syntax for freeform text.
function parseArgs(rawArgs) {
  let value = rawArgs;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      value = JSON.parse(value);
    } catch {
      // Not actually JSON; fall through to the plain string parsing below.
    }
  }
  if (typeof value === "object" && value !== null) {
    return {
      issue: value.issueNumber,
      mode: value.mode ?? "auto",
      clarificationAnswer: value.clarificationAnswer,
    };
  }
  const tokens = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  return { issue: tokens[0], mode: tokens[1] ?? "auto", clarificationAnswer: undefined };
}

const { issue, mode, clarificationAnswer } = parseArgs(args);
if (!issue) {
  throw new Error(
    'Missing issue number. Pass args: { issueNumber: N, mode: "auto" | "manual" }, or invoke as "/gh-pipeline N" or "/gh-pipeline N manual".',
  );
}
if (mode !== "auto" && mode !== "manual" && mode !== "merge") {
  throw new Error(`Unknown mode "${mode}". Use "auto", "manual", or "merge".`);
}

// merge mode is a standalone terminal action, not a pipeline phase: it
// only squash-merges the linked PR and closes the issue once a human
// has actually reached status:human-review. It never runs unattended
// as part of auto/manual mode, since human-review is the one point a
// person is meant to look at the result before it lands.
if (mode === "merge") {
  const currentStatus = await currentLabel(issue);
  if (currentStatus !== "status:human-review") {
    throw new Error(
      `Issue ${issue} is at ${currentStatus}, not status:human-review. Refusing to merge until a human ` +
        `has actually reached that review gate.`,
    );
  }
  const pr = await findLinkedPr(issue);
  if (!pr) {
    throw new Error(`Issue ${issue} is at status:human-review but no linked pull request was found.`);
  }
  await agent(`Run: gh pr merge ${pr} --squash --delete-branch`, { label: "merge-pr", model: "haiku" });
  await transitionTo(issue, "status:closed");
  log(`Issue ${issue} merged pull request ${pr} (squash) and transitioned to status:closed.`);
  return { issue, status: "merged", pr };
}

const auto = mode === "auto";
const buildDef = PHASE_DEFS.find((def) => def.key === "build");
const qaDef = PHASE_DEFS.find((def) => def.key === "qa");

// The scratch dir where all four agents read/write their artifact
// files. Created once up front; shared across every phase this run.
const dir = await scratchDir(issue);

let label = await currentLabel(issue);

// Resolve a pending gate first. A gate can only exist because a
// prior manual-mode run stopped there, so this applies regardless
// of the mode this run was invoked with.
const gateDef = PHASE_DEFS.find((def) => def.gateLabel === label);
if (gateDef) {
  // A caller (typically the agent that already relayed a clarification
  // question to a human and got an answer) can pass that answer
  // directly instead of first posting a /revise comment and
  // re-invoking. Only spec and plan ever raise a clarification, so this
  // only applies at their gates; it re-runs that phase's own agent with
  // the answer, edits the posted comment in place, and if the agent now
  // returns a clean "done", continues straight into the rest of the
  // pipeline in this same invocation instead of requiring a second run.
  if (clarificationAnswer && (gateDef.key === "spec" || gateDef.key === "plan")) {
    phase("Revise");
    const result = await reviseArtifact(issue, dir, gateDef, clarificationAnswer, { isClarificationAnswer: true });
    if (result.status === "clarification-needed") {
      // Still unresolved: re-post the (new) question and stay at the gate.
      await editTaggedComment(issue, gateDef, null, "clarification still open after the answer", {
        clarification: result,
      });
      log(
        `Issue ${issue} ${gateDef.key} still needs clarification after the answer; ` +
          `remains at ${label} for another /revise or clarificationAnswer.`,
      );
      return { issue, status: "waiting", gate: label };
    }
    await requireArtifact(dir, gateDef.artifact);
    await editTaggedComment(issue, gateDef, artifactPath(dir, gateDef), "folded in the answered clarification");
    await transitionTo(issue, gateDef.toStatus);
    label = await currentLabel(issue);
  } else {
    const comments = await commentsSinceTag(issue, gateDef);
    const directive = latestDirective(comments);

    if (!directive) {
      log(`Issue ${issue} is waiting for review at ${label}. Comment /approve or /revise <feedback> to continue.`);
      return { issue, status: "waiting", gate: label };
    }

    if (directive.kind === "revise") {
      phase("Revise");

      if (gateDef.key === "qa") {
        // QA's own rejection reasoning belongs to the code, not the
        // report: route the feedback (and the QA report itself, for
        // full context) to the build agent, then re-run QA and re-post
        // at the same gate rather than re-reviewing QA's own writeup.
        const qaReport = await readArtifact(dir, qaDef.artifact);
        phase("Build");
        await fixupBuild(issue, dir, buildDef, qaReport, directive.feedback);
        await requireArtifact(dir, buildDef.artifact);
        await postPrComment(issue, artifactPath(dir, buildDef));
        phase("QA");
        const { verdict } = await postQaArtifact(issue, dir, qaDef);
        await postReply(issue, gateDef, "QA re-reviewed after the build fixup.");
        log(`Issue ${issue} QA re-reviewed after build fixup (${verdict}), still awaiting /approve at ${label}.`);
        return { issue, status: "revised", gate: label, verdict };
      }

      const result = await reviseArtifact(issue, dir, gateDef, directive.feedback);
      if (result.status === "clarification-needed") {
        await editTaggedComment(issue, gateDef, null, "the revision surfaced a new open question", {
          clarification: result,
        });
        log(`Issue ${issue} ${gateDef.key} revision surfaced a new clarification, still at ${label}.`);
        return { issue, status: "revised", gate: label };
      }
      await requireArtifact(dir, gateDef.artifact);
      await editTaggedComment(issue, gateDef, artifactPath(dir, gateDef), `revised per /revise: ${directive.feedback}`);
      await postReply(issue, gateDef, `Revised the ${gateDef.key} per your feedback.`);
      log(`Issue ${issue} ${gateDef.key} revised, still awaiting /approve at ${label}.`);
      return { issue, status: "revised", gate: label };
    }

    // directive.kind === "approve"
    if (gateDef.key === "qa") {
      const verdict = parseVerdict(await readArtifact(dir, qaDef.artifact));
      await transitionTo(issue, verdict === "approved" ? "status:human-review" : "status:in-progress");
    } else {
      await transitionTo(issue, gateDef.toStatus);
    }
    label = await currentLabel(issue);
  }
}

// Walk the remaining phases in order from whichever real status we
// are now at.
for (const def of PHASE_DEFS) {
  if (!def.fromStatus.includes(label)) {
    continue;
  }

  phase(def.label);

  if (def.key === "qa") {
    let { verdict, report } = await postQaArtifact(issue, dir, def);

    if (mode === "manual") {
      await transitionTo(issue, def.gateLabel);
      log(`Issue ${issue} QA report posted (${verdict}), awaiting /approve at ${def.gateLabel}.`);
      return { issue, status: "awaiting_approval", gate: def.gateLabel, verdict };
    }

    // Auto mode: loop build -> QA on rejection, up to MAX_QA_ROUNDS
    // total build attempts, before giving up for a human to look at.
    let round = 1;
    while (verdict === "rejected" && round < MAX_QA_ROUNDS) {
      round += 1;
      phase("Build");
      await fixupBuild(issue, dir, buildDef, report, null);
      await requireArtifact(dir, buildDef.artifact);
      await postPrComment(issue, artifactPath(dir, buildDef));
      phase("QA");
      ({ verdict, report } = await postQaArtifact(issue, dir, def));
    }

    if (verdict === "rejected") {
      await transitionTo(issue, "status:in-progress");
      log(`Issue ${issue} still rejected after ${round} QA rounds; left at status:in-progress for a human.`);
      return { issue, status: "rejected", rounds: round };
    }

    await transitionTo(issue, "status:human-review");
    log(`Issue ${issue} QA approved after ${round} round(s).`);
    label = await currentLabel(issue);
    continue;
  }

  const result = await postArtifact(issue, dir, def, label, { auto });

  // Spec and plan are the only phases that can raise a clarification.
  // The gating that used to come from scanning the posted comment for a
  // [NEEDS CLARIFICATION] marker now comes from the agent's structured
  // clarification-needed return: a real, unresolved design ambiguity
  // should not be steamrolled by auto mode adopting the agent's
  // recommended default without a human ever seeing it, so force the
  // same gate manual mode uses, regardless of which mode this run was
  // invoked with. postArtifact already posted the rendered question as
  // the tagged comment for human visibility.
  if ((def.key === "spec" || def.key === "plan") && result.status === "clarification-needed") {
    await transitionTo(issue, def.gateLabel);
    log(
      `Issue ${issue} ${def.key} needs clarification; forcing a gate at ${def.gateLabel} regardless of mode. ` +
        `Comment /approve to accept the recommended default, or /revise <feedback> to resolve it differently.`,
    );
    return { issue, status: "awaiting_clarification", gate: def.gateLabel };
  }

  if (mode === "manual") {
    await transitionTo(issue, def.gateLabel);
    log(`Issue ${issue} ${def.key} posted, awaiting /approve at ${def.gateLabel}.`);
    return { issue, status: "awaiting_approval", gate: def.gateLabel };
  }

  await transitionTo(issue, def.toStatus);
  label = await currentLabel(issue);
}

log(`Issue ${issue} is at ${label}; nothing left for this workflow to drive.`);
return { issue, status: "done", label };
