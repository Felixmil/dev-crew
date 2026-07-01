// Copy this file into a target repo's .claude/workflows/ directory
// (plugins cannot distribute Workflow scripts today; only agents/
// are plugin-discoverable). Requires .claude/scripts/odt-transition.sh to
// also be copied into that repo's scripts/ directory, and the four
// agents from this plugin to be installed.
//
// Run with:
//   Workflow({ scriptPath: ".claude/workflows/openducktor-issue.js", args: { issueNumber: 142, mode: "auto" } })
//   Workflow({ scriptPath: ".claude/workflows/openducktor-issue.js", args: { issueNumber: 142, mode: "manual" } })
// or as a slash command: /openducktor-issue 142 (auto mode)
//                     or: /openducktor-issue 142 manual (manual mode)
//
// auto mode: identical to the original script. Every phase's output
// is immediately approved and the pipeline runs straight through to
// a QA verdict in one invocation.
//
// manual mode: each phase stops at a status:<phase>-awaiting-approval
// gate after posting its artifact as a tagged issue comment, and the
// run ends. A human reviews the artifact on the issue and comments
// either:
//   /approve                 -> advance to the next real status and
//                               continue into the next phase (which
//                               will stop at its own gate in turn)
//   /revise <feedback text>  -> re-run the same phase's agent with
//                               that feedback, editing the existing
//                               tagged comment in place and replying
//                               to the /revise comment, then stay at
//                               the same gate
// Re-running this script with the same issue number and mode: manual
// is always safe. If no /approve or /revise comment has been posted
// since the gate was set, it reports "waiting" and exits without
// doing anything.

export const meta = {
  name: "openducktor-issue",
  description:
    "Drive one GitHub issue through spec -> plan -> build -> qa, auto or gated on human approval",
  phases: [{ title: "Spec" }, { title: "Plan" }, { title: "Build" }, { title: "QA" }],
};

// GitHub notifies the issue author on any comment automatically, but
// an explicit @-mention is the reliable trigger regardless of that
// setting. Set this to the GitHub username who should be pinged when
// an artifact is posted or revised. Leave "" to disable mentioning.
const NOTIFY_GITHUB_USERNAME = "Felixmil";

const mentionSuffix = () =>
  NOTIFY_GITHUB_USERNAME ? ` Mention @${NOTIFY_GITHUB_USERNAME} in the comment so they are notified.` : "";

// In auto mode, a QA rejection sends the issue straight back to
// build, up to this many build -> QA rounds, before giving up and
// leaving it at status:in-progress for a human to look at.
const MAX_QA_ROUNDS = 3;

const PHASE_DEFS = [
  {
    key: "spec",
    label: "Spec",
    tag: "<!-- odt:spec -->",
    fromStatus: ["status:open"],
    gateLabel: "status:spec-awaiting-approval",
    toStatus: "status:spec-ready",
    agentType: "openducktor-agents:spec-agent",
    kickoff: (issue) => `Read GitHub issue ${issue} and write its specification.`,
    revisePrompt: (issue, feedback) =>
      `Read GitHub issue ${issue}. A human requested changes to the posted spec: "${feedback}". ` +
      `Edit the existing spec comment in place with the revised markdown (do not post a second spec comment), ` +
      `then post a short reply comment summarizing what changed.`,
  },
  {
    key: "plan",
    label: "Plan",
    tag: "<!-- odt:plan -->",
    fromStatus: ["status:spec-ready"],
    gateLabel: "status:plan-awaiting-approval",
    toStatus: "status:ready-for-dev",
    agentType: "openducktor-agents:planner-agent",
    kickoff: (issue) => `Read GitHub issue ${issue}'s spec and write its implementation plan.`,
    revisePrompt: (issue, feedback) =>
      `Read GitHub issue ${issue}. A human requested changes to the posted plan: "${feedback}". ` +
      `Edit the existing plan comment in place with the revised markdown (do not post a second plan comment), ` +
      `then post a short reply comment summarizing what changed.`,
  },
  {
    key: "build",
    label: "Build",
    tag: "<!-- odt:build -->",
    // ready-for-dev is the normal entry; a task/bug issue that skips
    // spec/plan starts at open -> in-progress directly (see the
    // README's skip-planning note), and a previously blocked build
    // resumes from blocked. All three enter the same start transition.
    fromStatus: ["status:ready-for-dev", "status:in-progress", "status:blocked"],
    // The transition table has no ready-for-dev -> ai-review edge:
    // starting work is its own transition (ready-for-dev/blocked ->
    // in-progress), matching OpenDucktor's odt_build_resumed/
    // odt_build_completed split. Applied before the agent runs, and
    // skipped when the issue is already at in-progress (the table has
    // no in-progress -> in-progress edge).
    gateLabel: "status:build-awaiting-approval",
    toStatus: "status:ai-review",
    agentType: "openducktor-agents:build-agent",
    kickoff: (issue) => `Implement GitHub issue ${issue} per its spec and plan.`,
    revisePrompt: (issue, feedback) =>
      `Read GitHub issue ${issue}. A human requested changes to the implementation: "${feedback}". ` +
      `Make the requested changes, update the existing completion-summary comment in place ` +
      `(do not post a second completion-summary comment), then post a short reply comment ` +
      `summarizing what changed.`,
    fixupPrompt: (issue, qaReport) =>
      `Read GitHub issue ${issue}. The QA agent reviewed the pull request and rejected it with this report:\n\n` +
      `${qaReport}\n\n` +
      `Address every rejection finding at the root cause, rerun relevant verification, and update the ` +
      `existing completion-summary comment in place (do not post a second completion-summary comment) ` +
      `describing what changed in response to the QA report.`,
  },
  {
    key: "qa",
    label: "QA",
    tag: "<!-- odt:qa -->",
    fromStatus: ["status:ai-review"],
    gateLabel: "status:qa-awaiting-approval",
    // No single toStatus: the QA verdict decides human-review vs in-progress.
    agentType: "openducktor-agents:qa-agent",
    kickoff: (issue) =>
      `Review the pull request for GitHub issue ${issue} against its spec and plan. ` +
      `End your report with exactly one line, either "QA-VERDICT: approved" or "QA-VERDICT: rejected".`,
    revisePrompt: (issue, feedback) =>
      `Read GitHub issue ${issue}. A human requested another look at the QA report: "${feedback}". ` +
      `Re-review, edit the existing QA report comment in place (do not post a second QA report comment), ` +
      `end it with exactly one "QA-VERDICT: approved" or "QA-VERDICT: rejected" line, ` +
      `then post a short reply comment summarizing what changed.`,
  },
];

async function transitionTo(issue, to) {
  await agent(`Run: bash .claude/scripts/odt-transition.sh ${issue} ${to}`, {
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

// Every comment on the issue that comes after the one tagged with
// `tag`, oldest first, as an array of { body } objects. [] if the
// tagged comment does not exist yet.
async function commentsSinceTag(issue, tag) {
  const jq =
    `.comments as $c | ($c | to_entries | map(select(.value.body | contains("${tag}"))) | ` +
    `if length == 0 then -1 else .[-1].key end) as $i | ` +
    `[$c[($i + 1):][] | {body: .body}]`;
  // Same structural risk as currentLabel(): an unconstrained agent
  // narrating an empty or malformed result instead of echoing raw
  // JSON would silently degrade to "no directive yet" today, which
  // happens to be a safe direction to fail in, but a schema removes
  // the ambiguity rather than relying on that being safe by luck.
  const out = await agent(
    `Run exactly: gh issue view ${issue} --json comments --jq '${jq}'. Set comments to the parsed JSON array from stdout, or [] if stdout was empty.`,
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

async function postArtifact(issue, def, currentStatus) {
  if (def.startStatus && currentStatus !== def.startStatus) {
    await transitionTo(issue, def.startStatus);
  }
  await agent(
    `${def.kickoff(issue)} Tag the posted comment's body with the literal text ${def.tag} on its own line.${mentionSuffix()}`,
    { agentType: def.agentType, phase: def.label },
  );
}

async function postQaArtifact(issue, def) {
  const report = await agent(
    `${def.kickoff(issue)} Tag the posted comment's body with the literal text ${def.tag} on its own line.${mentionSuffix()}`,
    { agentType: def.agentType, phase: def.label },
  );
  return { verdict: report.includes("QA-VERDICT: approved") ? "approved" : "rejected", report };
}

async function fixupBuild(issue, buildDef, qaReport) {
  await agent(`${buildDef.fixupPrompt(issue, qaReport)}${mentionSuffix()}`, {
    agentType: buildDef.agentType,
    phase: "Build",
  });
}

async function revise(issue, def, feedback) {
  const prompt = `${def.revisePrompt(issue, feedback)}${mentionSuffix()}`;
  if (def.key === "qa") {
    const report = await agent(prompt, { agentType: def.agentType, phase: "Revise" });
    return { verdict: report.includes("QA-VERDICT: approved") ? "approved" : "rejected", report };
  }
  await agent(prompt, { agentType: def.agentType, phase: "Revise" });
  return null;
}

// args arrives as one of:
//   { issueNumber: 142, mode: "auto" | "manual" }   (programmatic Workflow() call)
//   142                                              (bare number)
//   "142"                                            (slash command, no mode word)
//   "142 manual"                                     (slash command, with a mode word)
function parseArgs(rawArgs) {
  if (typeof rawArgs === "object" && rawArgs !== null) {
    return { issue: rawArgs.issueNumber, mode: rawArgs.mode ?? "auto" };
  }
  const tokens = String(rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
  return { issue: tokens[0], mode: tokens[1] ?? "auto" };
}

const { issue, mode } = parseArgs(args);
if (!issue) {
  throw new Error(
    'Missing issue number. Pass args: { issueNumber: N, mode: "auto" | "manual" }, or invoke as "/openducktor-issue N" or "/openducktor-issue N manual".',
  );
}
if (mode !== "auto" && mode !== "manual") {
  throw new Error(`Unknown mode "${mode}". Use "auto" or "manual".`);
}

const buildDef = PHASE_DEFS.find((def) => def.key === "build");
const qaDef = PHASE_DEFS.find((def) => def.key === "qa");

let label = await currentLabel(issue);

// Resolve a pending gate first. A gate can only exist because a
// prior manual-mode run stopped there, so this applies regardless
// of the mode this run was invoked with.
const gateDef = PHASE_DEFS.find((def) => def.gateLabel === label);
if (gateDef) {
  const comments = await commentsSinceTag(issue, gateDef.tag);
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
      const postGateComments = await commentsSinceTag(issue, gateDef.tag);
      const lastReport = [...postGateComments].reverse().find((c) => (c.body ?? "").includes("QA-VERDICT:"));
      phase("Build");
      await fixupBuild(issue, buildDef, `${lastReport?.body ?? ""}\n\nAdditional human feedback: ${directive.feedback}`);
      phase("QA");
      const { verdict } = await postQaArtifact(issue, qaDef);
      log(`Issue ${issue} QA re-reviewed after build fixup (${verdict}), still awaiting /approve at ${label}.`);
      return { issue, status: "revised", gate: label, verdict };
    }

    await revise(issue, gateDef, directive.feedback);
    log(`Issue ${issue} ${gateDef.key} revised, still awaiting /approve at ${label}.`);
    return { issue, status: "revised", gate: label };
  }

  // directive.kind === "approve"
  if (gateDef.key === "qa") {
    const postGateComments = await commentsSinceTag(issue, gateDef.tag);
    const verdictComment = [...postGateComments].reverse().find((c) => (c.body ?? "").includes("QA-VERDICT:"));
    const approved = (verdictComment?.body ?? "").includes("QA-VERDICT: approved");
    await transitionTo(issue, approved ? "status:human-review" : "status:in-progress");
  } else {
    await transitionTo(issue, gateDef.toStatus);
  }
  label = await currentLabel(issue);
}

// Walk the remaining phases in order from whichever real status we
// are now at.
for (const def of PHASE_DEFS) {
  if (!def.fromStatus.includes(label)) {
    continue;
  }

  phase(def.label);

  if (def.key === "qa") {
    let { verdict, report } = await postQaArtifact(issue, def);

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
      await fixupBuild(issue, buildDef, report);
      phase("QA");
      ({ verdict, report } = await postQaArtifact(issue, def));
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

  await postArtifact(issue, def, label);

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
